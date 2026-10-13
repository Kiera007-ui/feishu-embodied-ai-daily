export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(410).json({
    ok: false,
    error: "Manual sending is retired. Only the cloud daily workflow may send."
  });
}
