// Operator-only cutover. Never read desktop tokens or mint an admin session.
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/ai-cutover.mjs --phase=check|prepare|apply|finish [--origin=https://tr.zhangheng.eu.org]');
  console.log('Use TASKRELAY_ADMIN_COOKIE for an existing administrator session. apply requires --digest=<reviewed digest> --deployment-validated --executors-stopped --outboxes-drained. finish requires --post-cutover-validated.');
  process.exit(0);
}
const value = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const phase = value('phase') ?? 'check';
const origin = value('origin') ?? 'https://tr.zhangheng.eu.org';
if (!['https://tr.zhangheng.eu.org', 'https://taskrelay.zhangheng.workers.dev', 'http://127.0.0.1:5173'].includes(origin)) throw new Error('CUTOVER_ORIGIN_NOT_ALLOWED');
if (!['check', 'prepare', 'apply', 'finish'].includes(phase)) throw new Error('CUTOVER_PHASE_INVALID');
const digest = value('digest');
if (phase === 'apply' && (!/^[a-f0-9]{64}$/.test(digest ?? '') || !['--deployment-validated', '--executors-stopped', '--outboxes-drained'].every(a => args.includes(a)))) throw new Error('CUTOVER_VERIFICATION_REQUIRED');
if (phase === 'finish' && !args.includes('--post-cutover-validated')) throw new Error('POST_CUTOVER_VERIFICATION_REQUIRED');
const cookie = process.env.TASKRELAY_ADMIN_COOKIE;
if (!cookie) throw new Error('ADMIN_SESSION_REQUIRED');
const endpoint = phase === 'check' || phase === 'apply' ? '' : `/${phase}`;
const body = phase === 'apply' ? {digest, deploymentValidated:true, executorsStopped:true, outboxesDrained:true} : phase === 'finish' ? {postCutoverValidated:true} : {};
const response = await fetch(`${origin}/api/admin/cutover${endpoint}`, {
  method: phase === 'check' ? 'GET' : 'POST',
  headers: {Cookie:cookie, Origin:origin, 'Content-Type':'application/json'},
  ...(phase === 'check' ? {} : {body:JSON.stringify(body)}),
  redirect:'error', signal:AbortSignal.timeout(180000),
});
const data = await response.json();
if (!response.ok) throw new Error(data.error ?? `CUTOVER_HTTP_${response.status}`);
console.log(JSON.stringify(data, null, 2));
