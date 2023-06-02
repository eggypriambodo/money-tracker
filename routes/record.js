const express = require("express");
const mysql = require("mysql");
const router = express.Router();
const Multer = require("multer");
const imgUpload = require("../modules/imgUpload");
const connection = require("../database");

("use strict");

const createTcpPool = require("./connect-tcp.js");

const app = express();
app.set("view engine", "pug");
app.enable("trust proxy");

// Automatically parse request body as form data.
app.use(express.urlencoded({ extended: false }));
// This middleware is available in Express v4.16.0 onwards
app.use(express.json());

// Set Content-Type for all responses for these routes.
app.use((req, res, next) => {
  res.set("Content-Type", "text/html");
  next();
});

// Create a Winston logger that streams to Stackdriver Logging.
const winston = require("winston");
const { LoggingWinston } = require("@google-cloud/logging-winston");
const loggingWinston = new LoggingWinston();
const logger = winston.createLogger({
  level: "info",
  transports: [new winston.transports.Console(), loggingWinston],
});

// Retrieve and return a specified secret from Secret Manager
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const client = new SecretManagerServiceClient();

async function accessSecretVersion(secretName) {
  const [version] = await client.accessSecretVersion({ name: secretName });
  return version.payload.data;
}

const createPool = async () => {
  const config = {
    // [START cloud_sql_mysql_mysql_limit]
    // 'connectionLimit' is the maximum number of connections the pool is allowed
    // to keep at once.
    connectionLimit: 5,
    // [END cloud_sql_mysql_mysql_limit]

    // [START cloud_sql_mysql_mysql_timeout]
    // 'connectTimeout' is the maximum number of milliseconds before a timeout
    // occurs during the initial connection to the database.
    connectTimeout: 10000, // 10 seconds
    // 'acquireTimeout' is the maximum number of milliseconds to wait when
    // checking out a connection from the pool before a timeout error occurs.
    acquireTimeout: 10000, // 10 seconds
    // 'waitForConnections' determines the pool's action when no connections are
    // free. If true, the request will queued and a connection will be presented
    // when ready. If false, the pool will call back with an error.
    waitForConnections: true, // Default: true
    // 'queueLimit' is the maximum number of requests for connections the pool
    // will queue at once before returning an error. If 0, there is no limit.
    queueLimit: 0, // Default: 0
    // [END cloud_sql_mysql_mysql_timeout]

    // [START cloud_sql_mysql_mysql_backoff]
    // The mysql module automatically uses exponential delays between failed
    // connection attempts.
    // [END cloud_sql_mysql_mysql_backoff]
  };

  // Check if a Secret Manager secret version is defined
  // If a version is defined, retrieve the secret from Secret Manager and set as the DB_PASS
  const { CLOUD_SQL_CREDENTIALS_SECRET } = process.env;
  if (CLOUD_SQL_CREDENTIALS_SECRET) {
    const secrets = await accessSecretVersion(CLOUD_SQL_CREDENTIALS_SECRET);
    try {
      process.env.DB_PASS = secrets.toString();
    } catch (err) {
      err.message = `Unable to parse secret from Secret Manager. Make sure that the secret is JSON formatted: \n ${err.message} `;
      throw err;
    }
  }

  if (process.env.INSTANCE_HOST) {
    // Use a TCP socket when INSTANCE_HOST (e.g., 127.0.0.1) is defined
    return createTcpPool(config);
  } else {
    throw "Set either the `INSTANCE_HOST` or `INSTANCE_UNIX_SOCKET` environment variable.";
  }
};

const ensureSchema = async (pool) => {
  // Wait for tables to be created (if they don't already exist).
  await pool.query(
    `CREATE TABLE records (
      id INT AUTO_INCREMENT PRIMARY KEY NOT NULL,
      name VARCHAR(25) NOT NULL,
      amount DOUBLE NOT NULL,
      date DATETIME NOT NULL,
      notes TEXT,
      attachment VARCHAR(255)
  );`
  );
  console.log("Ensured that table 'votes' exists");
};

const createPoolAndEnsureSchema = async () =>
  await createPool()
    .then(async (pool) => {
      await ensureSchema(pool);
      return pool;
    })
    .catch((err) => {
      logger.error(err);
      throw err;
    });

let pool;

app.use(async (req, res, next) => {
  if (pool) {
    return next();
  }
  try {
    pool = await createPoolAndEnsureSchema();
    next();
  } catch (err) {
    logger.error(err);
    return next(err);
  }
});

const multer = Multer({
  storage: Multer.MemoryStorage,
  fileSize: 5 * 1024 * 1024,
});

router.get("/dashboard", (req, res) => {
  const query = "select (select count(*) from records where month(records.date) = month(now()) AND year(records.date) = year(now())) as month_records, (select sum(amount) from records) as total_amount;";
  pool.query(query, (err, rows, field) => {
    if (err) {
      res.status(500).send({ message: err.sqlMessage });
    } else {
      res.json(rows);
    }
  });
});

router.get("/getrecords", (req, res) => {
  const query = "SELECT * FROM records";
  pool.query(query, (err, rows, field) => {
    if (err) {
      res.status(500).send({ message: err.sqlMessage });
    } else {
      res.json(rows);
    }
  });
});

router.get("/getlast10records", (req, res) => {
  const query = "SELECT * FROM records ORDER BY date DESC LIMIT 10";
  pool.query(query, (err, rows, field) => {
    if (err) {
      res.status(500).send({ message: err.sqlMessage });
    } else {
      res.json(rows);
    }
  });
});

router.get("/gettopexpense", (req, res) => {
  const query = "SELECT * FROM records WHERE amount < 0 ORDER BY amount ASC LIMIT 10";
  pool.query(query, (err, rows, field) => {
    if (err) {
      res.status(500).send({ message: err.sqlMessage });
    } else {
      res.json(rows);
    }
  });
});

router.get("/getrecord/:id", (req, res) => {
  const id = req.params.id;

  const query = "SELECT * FROM records WHERE id = ?";
  pool.query(query, [id], (err, rows, field) => {
    if (err) {
      res.status(500).send({ message: err.sqlMessage });
    } else {
      res.json(rows);
    }
  });
});

router.get("/searchrecords", (req, res) => {
  const s = req.query.s;

  console.log(s);
  const query = "SELECT * FROM records WHERE name LIKE '%" + s + "%' or notes LIKE '%" + s + "%'";
  pool.query(query, (err, rows, field) => {
    if (err) {
      res.status(500).send({ message: err.sqlMessage });
    } else {
      res.json(rows);
    }
  });
});

router.post("/insertrecord", multer.single("attachment"), imgUpload.uploadToGcs, (req, res) => {
  const name = req.body.name;
  const amount = req.body.amount;
  const date = req.body.date;
  const notes = req.body.notes;
  var imageUrl = "";

  if (req.file && req.file.cloudStoragePublicUrl) {
    imageUrl = req.file.cloudStoragePublicUrl;
  }

  const query = "INSERT INTO records (name, amount, date, notes, attachment) values (?, ?, ?, ?, ?)";

  pool.query(query, [name, amount, date, notes, imageUrl], (err, rows, fields) => {
    if (err) {
      res.status(500).send({ message: err.sqlMessage });
    } else {
      res.send({ message: "Insert Successful" });
    }
  });
});

router.put("/editrecord/:id", multer.single("attachment"), imgUpload.uploadToGcs, (req, res) => {
  const id = req.params.id;
  const name = req.body.name;
  const amount = req.body.amount;
  const date = req.body.date;
  const notes = req.body.notes;
  var imageUrl = "";

  if (req.file && req.file.cloudStoragePublicUrl) {
    imageUrl = req.file.cloudStoragePublicUrl;
  }

  const query = "UPDATE records SET name = ?, amount = ?, date = ?, notes = ?, attachment = ? WHERE id = ?";

  pool.query(query, [name, amount, date, notes, imageUrl, id], (err, rows, fields) => {
    if (err) {
      res.status(500).send({ message: err.sqlMessage });
    } else {
      res.send({ message: "Update Successful" });
    }
  });
});

router.delete("/deleterecord/:id", (req, res) => {
  const id = req.params.id;

  const query = "DELETE FROM records WHERE id = ?";
  pool.query(query, [id], (err, rows, fields) => {
    if (err) {
      res.status(500).send({ message: err.sqlMessage });
    } else {
      res.send({ message: "Delete successful" });
    }
  });
});

router.post("/uploadImage", multer.single("image"), imgUpload.uploadToGcs, (req, res, next) => {
  const data = req.body;
  if (req.file && req.file.cloudStoragePublicUrl) {
    data.imageUrl = req.file.cloudStoragePublicUrl;
  }

  res.send(data);
});

module.exports = router;
