// PKB Homes brand lockup — recreated in CSS (gold bars · PKB · HOMES).
// The "PKB" word uses var(--text) so it reads on light and dark surfaces;
// the bars and "HOMES" use the brand gold.
export function Logo({ size = 40, stacked = true }: { size?: number; stacked?: boolean }) {
  return (
    <span
      className={`pkb-logo ${stacked ? 'stacked' : 'inline'}`}
      style={{ ['--logo-size' as string]: `${size}px` }}
      aria-label="PKB Homes"
      role="img"
    >
      <span className="pkb-bars"><i /><i /></span>
      <span className="pkb-text">
        <span className="pkb-word">PKB</span>
        <span className="pkb-homes">HOMES</span>
      </span>
    </span>
  );
}
