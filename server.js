var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var querystring = require('querystring');

var PORT = process.env.PORT || 3000;
var APP_FILE = path.join(__dirname, 'gluecks-app.html');
var TIMEOUT = 10000;

// --- Mojeek (primaere Suchquelle — eigener Index, kein Rate-Limit) ---

function searchMojeek(query) {
  var url = '/search?q=' + encodeURIComponent(query) + '&lang=de&fmt=1&num=10';

  return new Promise(function (resolve, reject) {
    var req = https.get({
      hostname: 'www.mojeek.com',
      path: url,
      timeout: TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8'
      }
    }, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        var results = parseMojeek(body);
        if (results.length > 0) {
          resolve({ results: results });
        } else {
          reject(new Error('Mojeek keine Ergebnisse'));
        }
      });
    });
    req.on('error', function (e) { reject(e); });
    req.on('timeout', function () { req.destroy(); reject(new Error('Mojeek timeout')); });
  });
}

function parseMojeek(html) {
  var results = [];
  var liRe = /<!--rs--><li class="r\d+">([\s\S]*?)<\/li><!--re-->/g;
  var m;
  while ((m = liRe.exec(html)) !== null && results.length < 10) {
    var block = m[1];
    var urlM = block.match(/href="(https?:\/\/[^"]+)" class="ob"/);
    var titleM = block.match(/class="title"[^>]*>([^<]+)<\/a>/);
    var snipM = block.match(/<p class="s">([\s\S]*?)<\/p>/);
    if (urlM && titleM) {
      results.push({
        url: urlM[1],
        title: titleM[1].trim(),
        content: snipM ? snipM[1].replace(/<[^>]+>/g, '').trim() : ''
      });
    }
  }
  return results;
}

// --- SearXNG (sekundaer — falls DDG ausfaellt) ---

var SEARXNG_INSTANCES = [
  'https://search.sapti.me',
  'https://searx.be',
  'https://searx.tiekoetter.com',
  'https://priv.au',
  'https://opnxng.com',
  'https://baresearch.org',
  'https://etsi.me',
  'https://paulgo.io',
  'https://s.mble.dk',
  'https://o5.gg'
];

function querySearXNG(instance, query) {
  var url = instance + '/search?q=' + encodeURIComponent(query) + '&format=json&language=de&categories=general';

  return new Promise(function (resolve, reject) {
    var req = https.get(url, {
      timeout: TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    }, function (res) {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(instance + ' ' + res.statusCode));
      }
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try {
          var data = JSON.parse(body);
          if (data.results && data.results.length > 0) {
            resolve(data);
          } else {
            reject(new Error(instance + ' no results'));
          }
        } catch (e) {
          reject(new Error(instance + ' invalid JSON'));
        }
      });
    });
    req.on('error', function (e) { reject(e); });
    req.on('timeout', function () { req.destroy(); reject(new Error(instance + ' timeout')); });
  });
}

function searchSearXNG(query) {
  var promises = SEARXNG_INSTANCES.map(function (inst) {
    return querySearXNG(inst, query);
  });
  return Promise.any(promises);
}

// --- Wikipedia (Fallback fuer Lernen-Modul / wenn alles andere ausfaellt) ---

function searchWikipedia(query) {
  var url = 'https://de.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
    encodeURIComponent(query) + '&srlimit=15&format=json&utf8=1';

  return new Promise(function (resolve, reject) {
    var req = https.get(url, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': 'GluecksApp/1.0' }
    }, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try {
          var data = JSON.parse(body);
          if (data.query && data.query.search && data.query.search.length > 0) {
            resolve({
              results: data.query.search.map(function (r) {
                return {
                  url: 'https://de.wikipedia.org/wiki/' + encodeURIComponent(r.title.replace(/ /g, '_')),
                  title: r.title,
                  content: r.snippet.replace(/<[^>]+>/g, '')
                };
              })
            });
          } else {
            reject(new Error('Wikipedia no results'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', function (e) { reject(e); });
    req.on('timeout', function () { req.destroy(); reject(new Error('Wikipedia timeout')); });
  });
}

// --- Suchkette: Mojeek → SearXNG → Wikipedia → leer ---

function search(query) {
  return searchMojeek(query)
    .catch(function () {
      console.log('[Suche] Mojeek fehlgeschlagen, versuche SearXNG fuer:', query);
      return searchSearXNG(query);
    })
    .catch(function () {
      console.log('[Suche] SearXNG fehlgeschlagen, versuche Wikipedia fuer:', query);
      return searchWikipedia(query);
    })
    .catch(function () {
      console.log('[Suche] Alle Quellen fehlgeschlagen fuer:', query);
      return { results: [] };
    });
}

// --- HTTP Server ---

var server = http.createServer(function (req, res) {
  var parsed = new URL(req.url, 'http://localhost');
  var pathname = parsed.pathname;

  // App ausliefern
  if ((pathname === '/' || pathname === '/gluecks-app.html') && req.method === 'GET') {
    fs.readFile(APP_FILE, function (err, data) {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Fehler beim Laden der App');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Such-API
  if (pathname === '/api/search' && req.method === 'GET') {
    var q = parsed.searchParams.get('q');
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Parameter q fehlt', results: [] }));
      return;
    }

    search(q).then(function (data) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

server.listen(PORT, function () {
  console.log('Gluecks-Server laeuft auf http://localhost:' + PORT);
});
