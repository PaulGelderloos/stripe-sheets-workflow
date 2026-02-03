const http = require('http');
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Test server draait op ${PORT}`);
});
```

En edit dan het `Procfile` bestand — verander:
```
web: node server.js
```

Naar:
```
web: node test-server.js
