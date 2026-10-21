// MT5 Router additions to the LGPL-3.0-or-later Windows redirector.
// The driver and upstream TCP/IP implementation are unchanged.
use anyhow::{ensure, Context, Result};
use internet_packet::{ConnectionId, TransportProtocol};
use mitmproxy::intercept_conf::ProcessInfo;
use serde::Deserialize;
use std::net::IpAddr;
use windows::core::PCWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE};

const PREFIX: &str = "MT5_ROUTER_V1:";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    version: u32,
    process: String,
    pid: Option<u32>,
    exclude_pid: u32,
    direct_ips: Vec<IpAddr>,
    ready_event: String,
}

impl Policy {
    pub fn from_actions(actions: &[String]) -> Result<Self> {
        ensure!(actions.len() == 1, "Exactly one MT5 routing policy is required");
        let hex = actions[0].strip_prefix(PREFIX).context("MT5 routing policy required")?;
        ensure!(hex.len() <= 16384 && hex.len() % 2 == 0
            && hex.bytes().all(|b| b.is_ascii_hexdigit()), "Invalid policy encoding");
        let bytes = (0..hex.len()).step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut policy: Self = serde_json::from_slice(&bytes)?;
        policy.direct_ips = policy.direct_ips.into_iter().map(canonical_ip).collect();
        ensure!(policy.version == 1, "Unsupported policy version");
        ensure!(policy.exclude_pid > 0, "Router PID is required");
        ensure!(policy.pid.is_none_or(|pid| pid > 0 && pid != policy.exclude_pid), "Invalid target PID");
        ensure!(policy.process.to_lowercase().ends_with(".exe")
            && !policy.process.chars().any(|c| ",!*?/\\:".contains(c))
            && policy.process.len() <= 260, "Exact executable name required");
        ensure!(policy.direct_ips.len() <= 64, "At most 64 direct IPs are supported");
        ensure!(policy.ready_event.starts_with("Local\\MT5RouterReady-")
            && policy.ready_event.len() > 21 && policy.ready_event.len() <= 120
            && policy.ready_event[21..].chars().all(|c| c.is_ascii_hexdigit() || c == '-'),
            "Invalid readiness event");
        Ok(policy)
    }

    pub fn should_intercept(&self, process: &ProcessInfo, connection: &ConnectionId) -> bool {
        if connection.proto != TransportProtocol::Tcp
            || !matches!(connection.dst.port(), 80 | 443)
            || self.direct_ips.iter().any(|ip| canonical_ip(*ip) == canonical_ip(connection.dst.ip()))
            || process.pid == self.exclude_pid {
            return false;
        }
        if let Some(pid) = self.pid {
            return process.pid == pid;
        }
        process.process_name.as_ref().is_some_and(|name| {
            let basename = name.rsplit(['\\', '/']).next().unwrap_or("");
            basename.to_lowercase() == self.process.to_lowercase()
        })
    }

    pub fn network_filter(&self) -> String {
        let mut filter = String::from("outbound && !loopback && tcp && (tcp.DstPort == 80 || tcp.DstPort == 443) && ((ip && remoteAddr < 224.0.0.0) || (ipv6 && remoteAddr < ff00::))");
        for ip in &self.direct_ips {
            let ip = canonical_ip(*ip);
            let field = if ip.is_ipv4() { "ip.DstAddr" } else { "ipv6.DstAddr" };
            let family = if ip.is_ipv4() { "ip" } else { "ipv6" };
            // WinDivert 2.2 permits negation of fields, not parenthesized groups.
            filter.push_str(&format!(" && (!{family} || {field} != {ip})"));
        }
        filter
    }

    pub fn signal_ready(&self) -> Result<()> {
        let name: Vec<u16> = self.ready_event.encode_utf16().chain(Some(0)).collect();
        // This only signals an event already created by the unelevated parent.
        // It does not write to an elevated caller-supplied filesystem path.
        unsafe {
            let event = OpenEventW(EVENT_MODIFY_STATE, false, PCWSTR::from_raw(name.as_ptr()))?;
            let result = SetEvent(event);
            CloseHandle(event)?;
            result?;
        }
        Ok(())
    }
}

fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip { IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip), _ => ip }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        Policy { version: 1, process: "terminal64.exe".into(), pid: None, exclude_pid: 99,
            direct_ips: vec!["203.0.113.20".parse().unwrap(), "2001:db8::20".parse().unwrap()],
            ready_event: "Local\\MT5RouterReady-123-abcd".into() }
    }
    fn connection(port: u16, ip: &str) -> ConnectionId {
        ConnectionId { proto: TransportProtocol::Tcp, src: "192.0.2.1:50000".parse().unwrap(),
            dst: std::net::SocketAddr::new(ip.parse().unwrap(), port) }
    }
    fn process(pid: u32, name: &str) -> ProcessInfo {
        ProcessInfo { pid, process_name: Some(name.into()) }
    }
    #[test]
    fn new_pid_is_selected_without_polling() {
        let p = policy();
        assert!(p.should_intercept(&process(1234, "C:\\MT5\\TERMINAL64.EXE"), &connection(443, "203.0.113.1")));
        assert!(p.should_intercept(&process(9876, "terminal64.exe"), &connection(80, "203.0.113.1")));
        assert!(!p.should_intercept(&process(1234, "other-terminal64.exe"), &connection(443, "203.0.113.1")));
    }
    #[test]
    fn only_web_tcp_is_intercepted() {
        let p = policy(); let proc = process(1234, "terminal64.exe");
        assert!(!p.should_intercept(&proc, &connection(1950, "203.0.113.1")));
        let mut udp = connection(443, "203.0.113.1"); udp.proto = TransportProtocol::Udp;
        assert!(!p.should_intercept(&proc, &udp));
        assert!(!p.should_intercept(&proc, &connection(443, "203.0.113.20")));
        assert!(!p.should_intercept(&proc, &connection(80, "2001:db8::20")));
        assert!(p.should_intercept(&proc, &connection(443, "2001:db8::21")));
    }
    #[test]
    fn explicit_pid_and_router_exclusion() {
        let mut p = policy(); p.pid = Some(1234);
        assert!(p.should_intercept(&process(1234, "python.exe"), &connection(80, "203.0.113.1")));
        assert!(!p.should_intercept(&process(5678, "terminal64.exe"), &connection(80, "203.0.113.1")));
        assert!(!p.should_intercept(&process(99, "terminal64.exe"), &connection(80, "203.0.113.1")));
    }
    #[test]
    fn policy_decode_and_validation() {
        let json = r#"{"version":1,"process":"terminal64.exe","pid":null,"exclude_pid":99,"direct_ips":[],"ready_event":"Local\\MT5RouterReady-123-abcd"}"#;
        let hex: String = json.bytes().map(|b| format!("{b:02x}")).collect();
        assert!(Policy::from_actions(&[format!("{PREFIX}{hex}")]).is_ok());
        assert!(Policy::from_actions(&[]).is_err());
        assert!(Policy::from_actions(&["terminal64.exe".into()]).is_err());
        assert!(Policy::from_actions(&[format!("{PREFIX}zz")]).is_err());
    }
    #[test]
    fn driver_filter_excludes_other_ports_udp_and_direct_ips() {
        let f = policy().network_filter();
        assert!(f.contains("outbound && !loopback && tcp"));
        assert!(f.contains("tcp.DstPort == 80 || tcp.DstPort == 443"));
        assert!(f.contains("(!ip || ip.DstAddr != 203.0.113.20)"));
        assert!(f.contains("(!ipv6 || ipv6.DstAddr != 2001:db8::20)"));
    }
    #[test]
    fn mapped_ipv4_is_excluded_from_native_selection_and_ipv4_filter() {
        let mut p = policy();
        p.direct_ips = vec!["::ffff:203.0.113.20".parse().unwrap()];
        assert!(!p.should_intercept(&process(1234, "terminal64.exe"), &connection(443, "203.0.113.20")));
        assert!(!p.should_intercept(&process(1234, "terminal64.exe"), &connection(443, "::ffff:203.0.113.20")));
        assert!(p.network_filter().contains("(!ip || ip.DstAddr != 203.0.113.20)"));
    }
    #[test]
    fn real_windivert_compiles_the_restricted_filter_without_loading_a_driver() {
        use std::ffi::{c_char, c_void, CStr, CString};
        #[link(name = "WinDivert")]
        unsafe extern "system" {
            fn WinDivertHelperCompileFilter(filter: *const c_char, layer: u32, object: *mut c_void,
                object_len: u32, error: *mut *const c_char, position: *mut u32) -> i32;
        }
        let filter = CString::new(policy().network_filter()).unwrap();
        let mut error = std::ptr::null();
        let mut position = 0;
        let ok = unsafe { WinDivertHelperCompileFilter(filter.as_ptr(), 0, std::ptr::null_mut(), 0, &mut error, &mut position) };
        let message = if error.is_null() { String::new() } else { unsafe { CStr::from_ptr(error).to_string_lossy().into_owned() } };
        assert_ne!(ok, 0, "Filter error at {position}: {message}");
    }
    #[test]
    fn real_driver_filter_evaluation_keeps_udp_other_ports_and_excluded_ips_outside_capture() {
        use std::ffi::{c_char, c_void, CString};
        use windivert::{address::WinDivertAddress, prelude::NetworkLayer};
        #[link(name = "WinDivert")]
        unsafe extern "system" {
            fn WinDivertHelperEvalFilter(filter: *const c_char, packet: *const c_void,
                len: u32, address: *const c_void) -> i32;
        }
        let filter = CString::new(policy().network_filter()).unwrap();
        let mut address = unsafe { WinDivertAddress::<NetworkLayer>::new() };
        address.set_outbound(true);
        for (proto, port, ip, expected) in [(6, 80u16, [203,0,113,1], true),
            (6,443,[203,0,113,1],true), (6,1950,[203,0,113,1],false),
            (17,80,[203,0,113,1],false), (17,443,[203,0,113,1],false),
            (6,443,[203,0,113,20],false)] {
            let mut packet = [0u8; 40];
            packet[0] = 0x45; packet[3] = 40; packet[8] = 64; packet[9] = proto;
            packet[12..16].copy_from_slice(&[192,0,2,1]); packet[16..20].copy_from_slice(&ip);
            packet[20..22].copy_from_slice(&50000u16.to_be_bytes()); packet[22..24].copy_from_slice(&port.to_be_bytes());
            if proto == 6 { packet[32] = 0x50; packet[33] = 2; } else { packet[25] = 20; }
            let result = unsafe { WinDivertHelperEvalFilter(filter.as_ptr(), packet.as_ptr().cast(), 40,
                (&address as *const WinDivertAddress<NetworkLayer>).cast()) };
            assert_eq!(result != 0, expected, "protocol {proto} port {port}");
        }
    }
}
