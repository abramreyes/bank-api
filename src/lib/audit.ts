export async function logAuditEvent(supabaseAdmin, event) {
  const {
    userId,
    action,
    resourceType = null,
    resourceId = null,
    ip = null,
    success,
    metadata = {}
  } = event;

  if (!action || typeof success !== 'boolean') {
    return;
  }

  try {
    await supabaseAdmin.from('audit_logs').insert({
      user_id: userId ?? null,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      ip,
      success,
      metadata
    });
  } catch (error) {
    // Audit logging must never break primary flows.
    // eslint-disable-next-line no-console
    console.error('Failed to write audit log:', error);
  }
}

