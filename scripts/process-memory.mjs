import {readFileSync} from 'node:fs';

/** Linux's per-address-space high-water mark, reset on exec. getrusage's
 * ru_maxrss can retain a pre-exec image containing memory from the launcher. */
export function parseProcessPeakRssKiB(status) {
 const match=/^VmHWM:\s*(\d+)\s+kB\s*$/m.exec(status),value=match&&Number(match[1]);
 if(!Number.isSafeInteger(value)||value<=0)throw Error('Linux process VmHWM missing or invalid; refusing an inherited RSS fallback');
 return value;
}
export function processPeakRssKiB() {
 if(process.platform!=='linux')throw Error('Process peak RSS qualification currently requires Linux /proc; native platform readers remain a release gate');
 return parseProcessPeakRssKiB(readFileSync('/proc/self/status','utf8'));
}
