import { spawn } from 'node:child_process';
const mode = process.argv[2];
if (mode === 'lines') {
  process.stdout.write('first\nsec');
  setTimeout(() => { process.stdout.write('ond\nlast'); process.stderr.write('diagnostic'); }, 15);
} else if (mode === 'tree') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', windowsHide: true, shell: false });
  process.stdout.write(`grandchild:${child.pid}\n`);
  setInterval(() => {}, 1000);
} else if (mode === 'env') {
  process.stdout.write(JSON.stringify({ proxy: process.env.HTTPS_PROXY, secret: process.env.OMNIPOST_PROXY, args: process.argv.slice(3) }) + '\n');
}
