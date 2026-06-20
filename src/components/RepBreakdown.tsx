import type { RepMetrics } from '../types'
import { formatSeconds, formatRom } from '../lib/timing'

// Per-rep velocity bars + a detail table. When `onRemove` is supplied each row
// gets a delete control (used on the Review screen to drop misdetected reps).
export const RepBreakdown = ({
  reps,
  onRemove,
}: {
  reps: RepMetrics[]
  onRemove?: (rep: RepMetrics) => void
}) => {
  if (reps.length === 0) {
    return <p className="muted">No reps {onRemove ? 'left' : 'were detected for this set'}.</p>
  }

  const maxVel = Math.max(...reps.map((r) => r.meanConcentricVelocity), 0.0001)
  // Only surface the hold column if any rep actually has hold data (old sets won't).
  const hasHolds = reps.some((r) => (r.holdTopMs ?? 0) > 0 || (r.holdBottomMs ?? 0) > 0)

  return (
    <div className="breakdown">
      <div className="chart" role="img" aria-label="Mean concentric velocity per rep">
        {reps.map((r, i) => (
          <div className="chart__col" key={r.index} title={`Rep ${i + 1}: ${(r.meanConcentricVelocity * 100).toFixed(0)} u/s`}>
            <div className="chart__bar" style={{ height: `${Math.max(5, (r.meanConcentricVelocity / maxVel) * 100)}%` }} />
            <span className="chart__x">{i + 1}</span>
          </div>
        ))}
      </div>

      <div className="table-wrap">
        <table className="rep-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Ecc ↓</th>
              <th>Con ↑</th>
              {hasHolds ? <th title="Pause held at the top / bottom of the rep">Hold ▲/▼</th> : null}
              <th>Frames</th>
              <th>ROM</th>
              <th>Vel</th>
              {onRemove ? <th aria-label="Remove" /> : null}
            </tr>
          </thead>
          <tbody>
            {reps.map((r, i) => (
              <tr key={r.index}>
                <td>{i + 1}</td>
                <td>{formatSeconds(r.eccentricMs)}</td>
                <td>{formatSeconds(r.concentricMs)}</td>
                {hasHolds ? (
                  <td className="muted">
                    {formatSeconds(r.holdTopMs ?? 0)} / {formatSeconds(r.holdBottomMs ?? 0)}
                  </td>
                ) : null}
                <td className="muted">
                  {r.eccentricFrames}/{r.concentricFrames}
                </td>
                <td>{formatRom(r.rangeOfMotion)}</td>
                <td>{(r.meanConcentricVelocity * 100).toFixed(0)}</td>
                {onRemove ? (
                  <td>
                    <button className="rep-remove" aria-label={`Remove rep ${i + 1}`} onClick={() => onRemove(r)}>
                      ✕
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
