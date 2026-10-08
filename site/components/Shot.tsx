/** A framed screenshot of the map (real output of Codiluce on an open-source repository). */
export function Shot({ src, alt, caption, priority = false, className }: { src: string; alt: string; caption?: string; priority?: boolean; className?: string }) {
  return (
    <figure className={`shot${className ? ` ${className}` : ''}`}>
      <div className="shot-frame">
        <div className="shot-bar" aria-hidden="true"><span /><span /><span /></div>
        {/* Static export: plain img with intrinsic size keeps layout stable without the image optimizer. */}
        <img src={src} alt={alt} width={2400} height={1500} loading={priority ? 'eager' : 'lazy'} decoding="async" fetchPriority={priority ? 'high' : 'auto'} />
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
