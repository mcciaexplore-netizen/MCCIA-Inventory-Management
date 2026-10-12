// Starts the API and the Vite client together; Ctrl+C stops both.
import { spawn } from 'node:child_process';

const run = (dir) => spawn('npm', ['run', 'dev', '--prefix', dir], { stdio: 'inherit', shell: true });
const procs = [run('server'), run('client')];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
procs.forEach((p) => p.on('exit', stop));
