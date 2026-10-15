import { NEXT_RELEASE, type NextFeature } from '../lib/site';

/** Marks a feature that is on main but not yet in the npm release. */
export function NextTag({ feature }: { feature: NextFeature }) {
  return NEXT_RELEASE.includes(feature) ? <span className="next-tag" title="On main now; in the npm package from the next release">Next release</span> : null;
}
