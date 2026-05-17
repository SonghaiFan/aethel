import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import {defineConfig, type Plugin} from 'vite';

const audioStaticPlugin = (): Plugin => ({
  name: 'music-topic-audio-static',
  configureServer(server) {
    const audioRoot = path.resolve(__dirname, '..', 'audio');

    server.middlewares.use('/audio', (req, res, next) => {
      if (!req.url) {
        next();
        return;
      }

      const decodedUrl = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.normalize(path.join(audioRoot, decodedUrl));
      if (!filePath.startsWith(audioRoot) || !filePath.endsWith('.wav')) {
        next();
        return;
      }

      fs.stat(filePath, (statError, stat) => {
        if (statError || !stat.isFile()) {
          next();
          return;
        }

        const range = req.headers.range;
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Accept-Ranges', 'bytes');

        if (range) {
          const [startText, endText] = range.replace(/bytes=/, '').split('-');
          const start = Number.parseInt(startText, 10);
          const end = endText ? Number.parseInt(endText, 10) : stat.size - 1;

          if (Number.isNaN(start) || Number.isNaN(end) || start >= stat.size) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${stat.size}`);
            res.end();
            return;
          }

          const chunkEnd = Math.min(end, stat.size - 1);
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${chunkEnd}/${stat.size}`);
          res.setHeader('Content-Length', chunkEnd - start + 1);
          fs.createReadStream(filePath, {start, end: chunkEnd}).pipe(res);
          return;
        }

        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(filePath).pipe(res);
      });
    });
  },
});

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), audioStaticPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
