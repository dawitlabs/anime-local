import { spawn } from 'node:child_process';
import path from 'node:path';

const [input, output] = process.argv.slice(2);
if (
  !input ||
  !output ||
  path.extname(output).toLowerCase() !== '.mp4' ||
  path.resolve(input) === path.resolve(output)
) {
  console.error(
    'Usage: npm run convert -- "input.mkv" "output.mp4"\nRequires FFmpeg. The input is kept and existing output files are never overwritten.',
  );
  process.exit(1);
}
const child = spawn(
  'ffmpeg',
  [
    '-n',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    output,
  ],
  { stdio: 'inherit' },
);
child.on('error', () => {
  console.error('Could not start FFmpeg. Install ffmpeg and try again.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
