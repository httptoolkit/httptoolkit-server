// Derived from mitmproxy's Windows redirector (40f1dfb5), LGPL-3.0-or-later.
// Signed WinDivert driver and upstream TCP/IP implementation are unchanged.
mod policy;
mod connections;
use connections::{Connections, PendingPackets};
use policy::Policy;
use anyhow::{anyhow, Context, Result};
use internet_packet::{ConnectionId, InternetPacket, TransportProtocol};
use mitmproxy::{ipc, MAX_PACKET_SIZE};
use mitmproxy::intercept_conf::ProcessInfo;
use mitmproxy::packet_sources::IPC_BUF_SIZE;
use mitmproxy::processes::get_process_name;
use mitmproxy::windows::network::{network_table, NetworkTableEntry};
use prost::Message;
use std::collections::HashSet;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient, PipeMode};
use tokio::sync::mpsc;
use windivert::address::WinDivertAddress;
use windivert::prelude::*;

type Packet = (WinDivertAddress<NetworkLayer>, InternetPacket);
#[derive(Debug, Clone)]
enum Action { Direct, Intercept(ProcessInfo), Drop }
struct Decision { action: Action, sequence: Option<u32> }
enum Event { Packet(WinDivertAddress<NetworkLayer>, Vec<u8>), Ipc(ipc::from_proxy::Message) }

fn connection(entry: &NetworkTableEntry) -> ConnectionId {
    ConnectionId { proto: TransportProtocol::Tcp, src: entry.local_addr, dst: entry.remote_addr }
}
fn choose_action(policy: Option<&Policy>, id: &ConnectionId, table: &[NetworkTableEntry]) -> Option<Action> {
    // Query the current OS owner for every initial SYN, including reused tuples.
    // Socket notification delivery order cannot substitute for connection identity.
    let row = table.iter().find(|e| e.protocol == 6 && e.pid != 0 && connection(e) == *id)?;
    let process = ProcessInfo { pid: row.pid, process_name: get_process_name(row.pid).ok().map(|p| p.to_string_lossy().into_owned()) };
    Some(if policy.is_some_and(|p| p.should_intercept(&process, id)) { Action::Intercept(process) } else { Action::Direct })
}
fn is_syn(packet: &InternetPacket) -> bool {
    packet.tcp_flags() & 0x12 == 0x02
}

#[tokio::main]
async fn main() -> Result<()> {
    if cfg!(debug_assertions) { env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init(); }
    let pipe = std::env::args().nth(1).context("Parent IPC pipe is required")?;
    publish_pid(&pipe)?; // Before IPC connection or any capture handle.
    let mut client = ClientOptions::new().read(true).write(true).pipe_mode(PipeMode::Message).open(&pipe)?;
    let mut buf = [0u8; IPC_BUF_SIZE];
    let len = client.read(&mut buf).await?;
    let initial = ipc::FromProxy::decode(&buf[..len])?;
    let Some(ipc::from_proxy::Message::InterceptConf(conf)) = initial.message else { anyhow::bail!("Expected initial routing policy"); };
    let mut policy = Some(Policy::from_actions(&conf.actions)?);
    let capture = WinDivert::network(&policy.as_ref().unwrap().network_filter(), 1040, WinDivertFlags::new())?;
    let inject = WinDivert::network("false", 1039, WinDivertFlags::new().set_send_only())?;
    let (events, mut rx) = mpsc::channel(256);
    let (packets, ipc_rx) = mpsc::channel(256);
    let tx = events.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; MAX_PACKET_SIZE];
        loop {
            match capture.recv_ex(Some(&mut buf), 1) {
                Ok(batch) => for p in batch {
                    if tx.blocking_send(Event::Packet(p.address, p.data.into())).is_err() { return; }
                },
                Err(_) => std::process::exit(74),
            }
        }
    });
    tokio::spawn(async move {
        if let Err(error) = relay_ipc(client, ipc_rx, events).await {
            log::error!("IPC failed: {error}"); std::process::exit(1);
        }
    });
    let mut known = Connections::new();
    let mut pending = PendingPackets::<ConnectionId, Packet>::new();
    for e in network_table()? {
        if e.protocol == 6 && !e.remote_addr.ip().is_unspecified() {
            known.insert(connection(&e), Decision { action: Action::Direct, sequence: None });
        }
    }
    policy.as_ref().unwrap().signal_ready()?;
    let mut maintenance = tokio::time::interval(Duration::from_millis(20));
    let mut reconciled = Instant::now();
    loop {
        let event = tokio::select! {
            event = rx.recv() => event.context("Capture event channel closed")?,
            _ = maintenance.tick() => {
                let keys = pending.keys();
                let now = Instant::now();
                if !keys.is_empty() || now.duration_since(reconciled) >= Duration::from_secs(15) {
                    // Failed snapshots must never evict otherwise live connections.
                    if let Ok(table) = network_table() {
                        for key in keys {
                            let action = choose_action(policy.as_ref(), &key, &table)
                                .or_else(|| pending.expired(&key, now).then_some(Action::Drop));
                            if let Some(action) = action {
                                for (address, packet) in pending.take(&key) { process_packet(address, packet, &action, &inject, &packets)?; }
                                let sequence = known.get(&key).and_then(|d| d.sequence);
                                known.insert(key, Decision { action, sequence });
                            }
                        }
                        if now.duration_since(reconciled) >= Duration::from_secs(15) {
                            let live: HashSet<_> = table.iter().filter(|e| e.protocol == 6).map(connection).collect();
                            known.reconcile(&live, now); reconciled = now;
                        }
                    } else {
                        for key in keys {
                            if pending.expired(&key, now) {
                                pending.take(&key);
                                let sequence = known.get(&key).and_then(|d| d.sequence);
                                known.insert(key, Decision { action: Action::Drop, sequence });
                            }
                        }
                    }
                }
                continue;
            }
        };
        match event {
            Event::Packet(address, data) => {
                let Ok(packet) = InternetPacket::try_from(data) else { continue; };
                let id = packet.connection_id();
                if is_syn(&packet) {
                    let sequence = Some(packet.tcp_sequence_number());
                    if known.get(&id).is_none_or(|d| d.sequence != sequence) {
                        pending.take(&id); // Never replay an older connection generation.
                    }
                    let action = network_table().ok().and_then(|table| choose_action(policy.as_ref(), &id, &table));
                    if let Some(action) = action {
                        for (a, p) in pending.take(&id) { process_packet(a, p, &action, &inject, &packets)?; }
                        known.insert(id.clone(), Decision { action, sequence });
                    } else {
                        // Invalidate any previous owner immediately, even if socket events lag.
                        known.insert(id.clone(), Decision { action: Action::Drop, sequence });
                        if !pending.push(id, (address, packet.clone()), packet.inner().len(), Instant::now()) {
                            log::warn!("Unresolved packet limit reached; packet dropped");
                        }
                        continue;
                    }
                } else if pending.contains(&id) {
                    if !pending.push(id, (address, packet.clone()), packet.inner().len(), Instant::now()) {
                        log::warn!("Unresolved packet limit reached; packet dropped");
                    }
                    continue;
                }
                // A non-SYN without a record predates capture. Never migrate it midstream.
                let action = known.get(&id).map(|d| &d.action).unwrap_or(&Action::Direct);
                process_packet(address, packet, action, &inject, &packets)?;
            }
            Event::Ipc(ipc::from_proxy::Message::Packet(ipc::Packet { data })) => {
                let mut address = unsafe { WinDivertAddress::<NetworkLayer>::new() };
                address.set_outbound(true);
                address.set_ip_checksum(false); address.set_tcp_checksum(false); address.set_udp_checksum(false);
                inject.send(&WinDivertPacket { address, data: data.as_ref().into() })?;
            }
            Event::Ipc(ipc::from_proxy::Message::InterceptConf(conf)) => {
                anyhow::ensure!(conf.actions.is_empty(), "Restart capture to change policy"); policy = None;
            }
        }
    }
}

fn process_packet(address: WinDivertAddress<NetworkLayer>, mut packet: InternetPacket, action: &Action,
                  inject: &WinDivert<NetworkLayer>, packets: &mpsc::Sender<ipc::PacketWithMeta>) -> Result<()> {
    match action {
        Action::Direct => { inject.send(&WinDivertPacket { address, data: packet.inner().into() })?; }
        Action::Intercept(process) => {
            if !address.ip_checksum() { packet.recalculate_ip_checksum(); }
            if !address.tcp_checksum() { packet.recalculate_tcp_checksum(); }
            let message = ipc::PacketWithMeta { data: packet.inner().into(),
                tunnel_info: Some(ipc::TunnelInfo { pid: Some(process.pid), process_name: process.process_name.clone() }) };
            match packets.try_send(message) {
                Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => {} // TCP retransmits under backpressure.
                Err(mpsc::error::TrySendError::Closed(_)) => anyhow::bail!("IPC packet channel closed"),
            }
        }
        Action::Drop => {}
    }
    Ok(())
}
async fn relay_ipc(mut client: NamedPipeClient, mut packets: mpsc::Receiver<ipc::PacketWithMeta>,
                   events: mpsc::Sender<Event>) -> Result<()> {
    let mut buf = [0u8; IPC_BUF_SIZE];
    loop {
        tokio::select! {
            result = client.read(&mut buf) => {
                let len = result?;
                if len == 0 { std::process::exit(0); }
                let message = ipc::FromProxy::decode(&buf[..len])?.message.context("Empty IPC message")?;
                events.send(Event::Ipc(message)).await?;
            }
            Some(packet) = packets.recv() => {
                packet.encode(&mut buf.as_mut_slice())?;
                client.write_all(&buf[..packet.encoded_len()]).await?;
            }
        }
    }
}

fn publish_pid(pipe: &str) -> Result<()> {
    use windows::Win32::System::Memory::{OpenFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_WRITE};
    use windows::Win32::Foundation::CloseHandle;
    use windows::core::PCWSTR;
    let pid = pipe.strip_prefix(r"\\.\pipe\mitmproxy-transparent-proxy-").context("Unexpected parent pipe")?;
    anyhow::ensure!(!pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()), "Invalid parent PID");
    let name: Vec<u16> = format!("Local\\MT5RouterPid-{pid}").encode_utf16().chain(Some(0)).collect();
    unsafe {
        let mapping = OpenFileMappingW(FILE_MAP_WRITE.0, false, PCWSTR::from_raw(name.as_ptr()))?;
        let view = MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, 4);
        if view.Value.is_null() { CloseHandle(mapping)?; return Err(anyhow!("Cannot map parent PID report")); }
        (view.Value as *mut u32).write_volatile(std::process::id());
        let result = UnmapViewOfFile(view);
        CloseHandle(mapping)?; result?;
    }
    Ok(())
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn native_pid_report_writes_the_parent_mapping_before_capture() {
        use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows::Win32::System::Memory::{CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_READ, PAGE_READWRITE};
        use windows::core::PCWSTR;
        let parent = std::process::id() as u64 + 0x10000000;
        let name: Vec<u16> = format!("Local\\MT5RouterPid-{parent}").encode_utf16().chain(Some(0)).collect();
        unsafe {
            let mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, None, PAGE_READWRITE, 0, 4, PCWSTR::from_raw(name.as_ptr())).unwrap();
            let view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 4);
            assert!(!view.Value.is_null());
            assert_eq!((view.Value as *const u32).read_volatile(), 0);
            publish_pid(&format!(r"\\.\pipe\mitmproxy-transparent-proxy-{parent}")).unwrap();
            assert_eq!((view.Value as *const u32).read_volatile(), std::process::id());
            UnmapViewOfFile(view).unwrap(); CloseHandle(mapping).unwrap();
        }
        assert!(publish_pid("not-a-parent-pipe").is_err());
    }
    #[test]
    fn reused_tuple_uses_live_owner_in_either_notification_order() {
        let id = ConnectionId { proto: TransportProtocol::Tcp, src: "192.0.2.1:50000".parse().unwrap(), dst: "203.0.113.1:443".parse().unwrap() };
        let row = NetworkTableEntry { protocol: 6, local_addr: id.src, remote_addr: id.dst, pid: std::process::id() };
        let json = format!(r#"{{"version":1,"process":"unused.exe","pid":{},"exclude_pid":4294967295,"direct_ips":[],"ready_event":"Local\\MT5RouterReady-123-abcd"}}"#, std::process::id());
        let hex: String = json.bytes().map(|b| format!("{b:02x}")).collect();
        let policy = Policy::from_actions(&[format!("MT5_ROUTER_V1:{hex}")]).unwrap();
        for old in [Action::Direct, Action::Intercept(ProcessInfo { pid: 123, process_name: None })] {
            let mut known = Connections::new(); known.insert(id.clone(), old);
            // Socket events are deliberately not inputs to classification.
            known.insert(id.clone(), choose_action(Some(&policy), &id, &[row.clone()]).unwrap());
            assert!(matches!(known.get(&id), Some(Action::Intercept(p)) if p.pid == std::process::id()));
            let mut other = row.clone(); other.pid = 4294967294;
            known.insert(id.clone(), choose_action(Some(&policy), &id, &[other]).unwrap());
            assert!(matches!(known.get(&id), Some(Action::Direct)));
            assert!(choose_action(None, &id, &[]).is_none());
        }
    }
    #[test]
    fn syn_detection_distinguishes_new_connections_from_acknowledgements() {
        let mut bytes = vec![0u8; 40];
        bytes[0] = 0x45; bytes[3] = 40; bytes[9] = 6; bytes[32] = 0x50; bytes[33] = 2;
        let mut packet = InternetPacket::try_from(bytes).unwrap();
        assert!(is_syn(&packet));
        packet.set_tcp_flags(0x12); assert!(!is_syn(&packet));
        packet.set_tcp_flags(0x10); assert!(!is_syn(&packet));
    }
}
