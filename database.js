const mysql = require("mysql");

const DB_HOST = "104.198.38.230";
const DB_NAME = "mymoney";
const DB_USER = "root";
const DB_PASS = "projektcc";
const INSTANCE_CONNECTION_NAME = "tugas-akhir-praktcc:us-central1:money-tracker-db";
const NODE_ENV = "value: production";

var config = {
  user: DB_USER,
  database: DB_NAME,
  password: DB_PASS,
};

// Later on when running from Google Cloud, env variables will be passed in container cloud connection config
if (NODE_ENV === "production") {
  console.log("Running from cloud. Connecting to DB through GCP socket.");
  config.socketPath = `/cloudsql/${INSTANCE_CONNECTION_NAME}`;
}

// When running from localhost, get the config from .env
else {
  console.log("Running from localhost. Connecting to DB directly.");
  config.host = DB_HOST;
}

let connection = mysql.createConnection(config);

connection.connect(function (err) {
  if (err) {
    console.error("Error connecting: " + err.stack);
    return;
  }
  console.log("Connected as thread id: " + connection.threadId);
});

module.exports = connection;
