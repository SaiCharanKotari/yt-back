import { execSync } from 'child_process';

const port = process.argv[2];
if (!port) {
  console.log('[kill-port] No port specified.');
  process.exit(0);
}

const targetPort = parseInt(port, 10);
if (isNaN(targetPort)) {
  console.log(`[kill-port] Invalid port: ${port}`);
  process.exit(0);
}

console.log(`[kill-port] Checking for existing processes on port ${targetPort}...`);

const isWin = process.platform === 'win32';

try {
  if (isWin) {
    // Run netstat -ano to capture both IPv4 and IPv6 listeners (e.g. Vite on [::1]:5173)
    const output = execSync('netstat -ano', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = output.split('\n');
    const pids = new Set();
    const portRegex = new RegExp(`[:.]${targetPort}\\s+`);
    
    for (const line of lines) {
      if (line.includes('LISTENING') && portRegex.test(line)) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && !isNaN(pid) && parseInt(pid, 10) > 0 && parseInt(pid, 10) !== process.pid) {
          pids.add(pid);
        }
      }
    }

    if (pids.size === 0) {
      console.log(`[kill-port] Port ${targetPort} is clear.`);
    } else {
      for (const pid of pids) {
        console.log(`[kill-port] Terminating existing process PID ${pid} on port ${targetPort}...`);
        try {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
          console.log(`[kill-port] Process PID ${pid} terminated successfully.`);
        } catch (err) {
          try {
            execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
            console.log(`[kill-port] Process PID ${pid} terminated successfully.`);
          } catch (e) {
            // Process may have already exited
          }
        }
      }
    }
  } else {
    try {
      const pidsStr = execSync(`lsof -t -i:${targetPort}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      if (pidsStr) {
        const pids = pidsStr.split('\n');
        for (const pid of pids) {
          if (pid && parseInt(pid, 10) !== process.pid) {
            console.log(`[kill-port] Terminating existing process PID ${pid} on port ${targetPort}...`);
            execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
          }
        }
      } else {
        console.log(`[kill-port] Port ${targetPort} is clear.`);
      }
    } catch (err) {
      console.log(`[kill-port] Port ${targetPort} is clear.`);
    }
  }
} catch (e) {
  console.log(`[kill-port] Port ${targetPort} check completed.`);
}
