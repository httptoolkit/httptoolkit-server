import * as _ from 'lodash';
import * as os from 'os';

export function getReachableInterfaces() {
    return _.flatMap(os.networkInterfaces(), (addresses, iface) =>
        (addresses || [])
            .filter(a =>
                !a.internal && // Loopback interfaces
                iface !== 'docker0' && // Docker default bridge interface
                !iface.startsWith('br-') && // More docker bridge interfaces
                !iface.startsWith('veth') // Virtual interfaces for each docker container
            )
    )
}