const BASE = process.env.BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.EMAIL || 'admin@vivacollege.org';
const PASSWORD = process.env.PASSWORD || 'admin123';
const REQUESTS = Number(process.env.REQUESTS || 200);
const CONCURRENCY = Number(process.env.CONCURRENCY || 20);

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed with status ${res.status}`);
  return (await res.json()).token;
}

async function run() {
  const token = await login();
  const timings = [];
  let sent = 0;

  const worker = async () => {
    while (sent < REQUESTS) {
      sent += 1;
      const start = performance.now();
      const res = await fetch(`${BASE}/api/skills`, { headers: { Authorization: `Bearer ${token}` } });
      await res.text();
      timings.push({ ms: performance.now() - start, ok: res.ok });
    }
  };

  const begin = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = (performance.now() - begin) / 1000;

  const sorted = timings.map((t) => t.ms).sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const failed = timings.filter((t) => !t.ok).length;

  console.log(`Requests sent        : ${timings.length}`);
  console.log(`Concurrent users     : ${CONCURRENCY}`);
  console.log(`Failed requests      : ${failed}`);
  console.log(`Total time           : ${seconds.toFixed(2)} s`);
  console.log(`Throughput           : ${(timings.length / seconds).toFixed(1)} requests per second`);
  console.log(`Fastest / median     : ${sorted[0].toFixed(1)} ms / ${pick(0.5).toFixed(1)} ms`);
  console.log(`95th percentile      : ${pick(0.95).toFixed(1)} ms`);
  console.log(`Slowest              : ${sorted[sorted.length - 1].toFixed(1)} ms`);
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
