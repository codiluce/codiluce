import { CopyButton } from './CopyButton';

/** A shell or config snippet. Lines starting with `#` render as comments; `prompt` prefixes commands with `$`. */
export function CodeBlock({ code, title, prompt = false }: { code: string; title?: string; prompt?: boolean }) {
  const lines = code.replace(/\n$/, '').split('\n');
  const copyText = lines.filter(line => !(prompt && line.trimStart().startsWith('#'))).join('\n');
  return (
    <figure className="code-block">
      {title ? <figcaption>{title}</figcaption> : null}
      <div className="code-body">
        <pre>
          {lines.map((line, index) => {
            const comment = line.trimStart().startsWith('#');
            return (
              <code key={index} className={comment ? 'comment' : undefined}>
                {prompt && !comment && line ? <span className="prompt" aria-hidden="true">$ </span> : null}
                {line}
                {'\n'}
              </code>
            );
          })}
        </pre>
        <CopyButton text={copyText} />
      </div>
    </figure>
  );
}
