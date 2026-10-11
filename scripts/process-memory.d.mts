export function parseProcessPeakRssKiB(status:string):number;
export function processPeakRssKiB():number;
export interface ProcessTreeMemory {available:boolean;rssKiB:number;childRssKiB:number;processes:number;incomplete:boolean;pids:number[]}
export function sampleProcessTreeRssKiB(pid:number,procRoot?:string):ProcessTreeMemory;
