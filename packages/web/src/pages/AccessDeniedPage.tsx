export function AccessDeniedPage() {
  return (
    <div className="card empty-state">
      <h1>Blocksmith access is not assigned</h1>
      <p className="text-muted">
        Your account is signed in, but it does not have access to this tool.
        Contact an administrator.
      </p>
    </div>
  );
}
