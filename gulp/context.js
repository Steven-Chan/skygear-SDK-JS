var execSync = require('child_process').execSync;
var version = execSync('git describe --always --tags --dirty') + "";
version = version.trim();

module.exports = {
  "dev": {
    "API_URL": "http://skygear.dev/",
    "SKYGEAR_VERSION": version
  },
  "production": {
    "API_URL": "http://myapp.skygeario.com/",
    "SKYGEAR_VERSION": version
  }
}
