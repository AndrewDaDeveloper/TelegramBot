var http = require('https');

http.createServer(function (req, res) {
  res.write("I'm alive");
  res.end();
}).listen(8080)
