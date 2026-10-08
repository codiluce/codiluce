/**
 * An example request flow drawn as lanes: a pulse runs down the chain and lights each stop, like a flow playing
 * on the map. On the map, every link carries its evidence.
 */
const STOPS = [
  { lane: 'Frontend', name: 'page /account', kind: 'page', via: '' },
  { lane: '', name: 'AccountPanel', kind: 'component', via: 'renders' },
  { lane: '', name: 'handleSave', kind: 'function', via: 'onClick' },
  { lane: '', name: 'AccountService.signIn()', kind: 'method', via: 'calls' },
  { lane: 'HTTP', name: 'POST /auth/login', kind: 'request', via: 'requests · base URL from API_BASE_URL' },
  { lane: 'Backend', name: 'AuthController.login', kind: 'endpoint', via: 'handles' },
  { lane: '', name: 'AuthService.authenticate', kind: 'method', via: 'calls' },
  { lane: 'Database', name: 'users', kind: 'table', via: 'reads · model User' },
];

export function FlowChain() {
  return (
    <figure className="flow-card" aria-label="A flow from a page of the interface down to a database table">
      <figcaption className="flow-head">
        <span className="flow-dot" aria-hidden="true" />
        <span>Flow</span>
        <code>POST /auth/login</code>
        <span className="flow-branch">branch /account</span>
      </figcaption>
      <div className="flow-body" style={{ ['--stops' as string]: STOPS.length }}>
        <ol className="flow-list">
          {STOPS.map((stop, index) => (
            <li key={stop.name} className="flow-stop" style={{ ['--i' as string]: index }}>
              <span className="flow-lane">{stop.lane}</span>
              <span className="flow-node" aria-hidden="true" />
              <span className="flow-text">
                <span className="flow-name">{stop.name}</span>
                <span className="flow-meta">
                  <span className="flow-kind">{stop.kind}</span>
                  {stop.via ? <span className="flow-via">{stop.via}</span> : null}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <span className="flow-pulse" aria-hidden="true" />
      </div>
      <p className="flow-foot">Each link opens its evidence: analyzer, file and line.</p>
    </figure>
  );
}
