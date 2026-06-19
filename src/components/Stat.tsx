export const Stat = ({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent?: boolean
}) => (
  <div className={`stat${accent ? ' stat--accent' : ''}`}>
    <div className="stat__value">{value}</div>
    <div className="stat__label">{label}</div>
    {sub ? <div className="stat__sub">{sub}</div> : null}
  </div>
)
