// PKB Homes logo — real artwork (frontend/public/logo-pkb.png).
// `size` is the rendered height in px. On dark surfaces the CSS gives it a light
// plate so the graphite "PKB" stays legible (the file is the light-background variant).
export function Logo({ size = 40 }: { size?: number; stacked?: boolean }) {
  return (
    <img
      src="/logo-pkb.png"
      alt="PKB Homes"
      className="pkb-logo-img"
      style={{ height: size, width: 'auto' }}
    />
  );
}
