// MT5 Router additions, LGPL-3.0-or-later.
use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::time::{Duration, Instant};

// Only absent OS connections are retired. Idle live connections never expire.
pub struct Connections<K, V> {
    entries: HashMap<K, (V, Option<Instant>)>,
}
impl<K: Eq + Hash, V> Connections<K, V> {
    pub fn new() -> Self { Self { entries: HashMap::new() } }
    pub fn get(&self, key: &K) -> Option<&V> { self.entries.get(key).map(|x| &x.0) }
    pub fn insert(&mut self, key: K, value: V) {
        self.entries.insert(key, (value, None));
    }
    pub fn reconcile(&mut self, live: &HashSet<K>, now: Instant) {
        self.entries.retain(|key, (_, absent)| {
            if live.contains(key) { *absent = None; true }
            else { now.duration_since(*absent.get_or_insert(now)) < Duration::from_secs(60) }
        });
    }
}

struct Pending<T> { items: Vec<T>, bytes: usize, since: Instant }
pub struct PendingPackets<K, T> {
    entries: HashMap<K, Pending<T>>,
    bytes: usize,
}
impl<K: Eq + Hash + Clone, T> PendingPackets<K, T> {
    pub fn new() -> Self { Self { entries: HashMap::new(), bytes: 0 } }
    pub fn contains(&self, key: &K) -> bool { self.entries.contains_key(key) }
    pub fn keys(&self) -> Vec<K> { self.entries.keys().cloned().collect() }
    pub fn push(&mut self, key: K, item: T, bytes: usize, now: Instant) -> bool {
        if self.bytes.saturating_add(bytes) > 4 * 1024 * 1024
            || (!self.entries.contains_key(&key) && self.entries.len() >= 256)
            || self.entries.get(&key).is_some_and(|x| x.items.len() >= 64) { return false; }
        let pending = self.entries.entry(key).or_insert_with(|| Pending { items: Vec::new(), bytes: 0, since: now });
        pending.items.push(item);
        pending.bytes += bytes;
        self.bytes += bytes;
        true
    }
    pub fn take(&mut self, key: &K) -> Vec<T> {
        self.entries.remove(key).map(|p| { self.bytes -= p.bytes; p.items }).unwrap_or_default()
    }
    pub fn expired(&self, key: &K, now: Instant) -> bool {
        self.entries.get(key).is_some_and(|x| now.duration_since(x.since) >= Duration::from_secs(2))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_idle_connections_survive_hours_but_closed_connections_are_retired() {
        let now = Instant::now();
        let mut c = Connections::new();
        c.insert(1, "direct"); c.insert(2, "intercept");
        let live = HashSet::from([1, 2]);
        c.reconcile(&live, now + Duration::from_secs(3600));
        assert_eq!(c.get(&1), Some(&"direct"));
        assert_eq!(c.get(&2), Some(&"intercept"));
        c.reconcile(&HashSet::from([1]), now + Duration::from_secs(3601));
        c.reconcile(&HashSet::from([1]), now + Duration::from_secs(3662));
        assert!(c.get(&2).is_none());
        assert_eq!(c.get(&1), Some(&"direct"));
    }
    #[test]
    fn unresolved_packets_have_per_flow_global_byte_and_age_limits() {
        let now = Instant::now();
        let mut p = PendingPackets::new();
        for _ in 0..64 { assert!(p.push(1, (), 1, now)); }
        assert!(!p.push(1, (), 1, now));
        assert!(!p.push(2, (), 4 * 1024 * 1024, now));
        assert!(p.expired(&1, now + Duration::from_secs(2)));
        assert_eq!(p.take(&1).len(), 64);
        assert!(p.push(2, (), 4 * 1024 * 1024, now));
        p.take(&2);
        for key in 0..256 { assert!(p.push(key, (), 1, now)); }
        assert!(!p.push(256, (), 1, now));
    }
}
