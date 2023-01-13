const compression = require('compression');
const express = require('express');
const helmet = require('helmet');
const mysql2 = require('mysql2/promise');
const winston = require('winston'); require('winston-daily-rotate-file');
const config = require('./tamugd_config.js');

// create logger
const logger = winston.createLogger({
    level: 'info',
    format: 
        winston.format.printf(({ message }) => {
            const now = new Date();
            const date = now.getFullYear()+'-'+('0'+(now.getMonth()+1)).slice(-2)+'-'+('0'+now.getDate()).slice(-2);
            const time = ('0'+now.getHours()).slice(-2)+':'+('0'+now.getMinutes()).slice(-2)+':'+('0'+now.getSeconds()).slice(-2);
            return `[${date}.${time}] ${message}`;
        }),
    transports: [
        new winston.transports.Console(),
        new winston.transports.DailyRotateFile({
            level: 'info',
            dirname: 'logs/',
            filename: '%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '30d'
        }),
    ],
});

// create express instance
const app = express();
let RESPONSE_CACHE = {};
let IS_CACHE_STALE = true;

// trust one layer of proxies (cf)
app.set('trust proxy', 1);
app.use(compression());

// configure helmetjs for header hardening
app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            "default-src": ["'self'", 'https://www.google-analytics.com/g/'],
            "script-src-attr": ["'self'", "'unsafe-inline'"],
            "script-src": ["'self'", "'unsafe-inline'", 'https://www.googletagmanager.com/gtag/', 'https://www.google-analytics.com/g/'],
            "style-src": ["'self'", "'unsafe-inline'"],
            "font-src": ["'self'", 'https://stackpath.bootstrapcdn.com/font-awesome/', 'https://fonts.gstatic.com/s/'],
            "img-src": ["'self'", 'data:', 'https://www.google-analytics.com/g/']
        }
    },
    referrerPolicy: 'origin'
}));

// get referrer if available
app.use('/', async (req, res, next) => {
    const ip = (req.headers['cf-connecting-ip'] || req.ip);
    const fip = ip.split(ip.length>15?':':'.').map(n => ('000'+n).slice(ip.length>15?-4:-3)).join(ip.length>15?':':'.');
    if (req.get('Referrer')) logger.info(`[${fip}] [Referred By: ${req.get('Referrer')}]`);
    next();
});

// set ./public as root directory
app.use(express.static('public'));

// set /favicon.ico as an alias to actual location
app.get('/favicon.ico', async (req, res) => res.status(200).sendFile(__dirname+'/public/img/favicon.ico'));

// return information about the grade data in the database and database building progress
app.get('/supported', async (req, res) => {
    const ip = (req.headers['cf-connecting-ip'] || req.ip);
    const fip = ip.split(ip.length>15?':':'.').map(n => ('000'+n).slice(ip.length>15?-4:-3)).join(ip.length>15?':':'.');
    
    try {
        const conn = await mysql2.createConnection(config.databaseSettings);
        const [rows1] = await conn.execute(`SELECT * FROM ${config.statusTable};`);

        // if DB is building, not cached, or stale
        if (Number(rows1[0].value) < 100 || !RESPONSE_CACHE['supported'] || IS_CACHE_STALE) {
            const [rows2] = await conn.execute(`SELECT DISTINCT year FROM ${config.gradesTable};`);
            const [rows3] = await conn.execute(`SELECT DISTINCT departmentName FROM ${config.gradesTable};`);

            // generate and cache response
            IS_CACHE_STALE = Number(rows1[0].value) < 100;
            RESPONSE_CACHE = {};
            RESPONSE_CACHE['supported'] = {
                years: Object.values(rows2).map(e => e.year),
                departments: Object.values(rows3).map(e => e.departmentName),
                buildPercentage: Number(rows1[0].value)
            };
            res.status(200).json(RESPONSE_CACHE['supported']).end();
            logger.info(`[${fip}] [${(rows2.length+rows3.length)>0?'✔️':'❌'} Queried] [GET /supported]`);
        }

        // get cached response
        else {
            res.status(200).json(RESPONSE_CACHE['supported']).end();
            logger.info(`[${fip}] [✔️  Cached] [GET /supported]`);
        }

        await conn.end();

    // catch and log errors, notify frontend
    } catch (err) {
        res.write('Backend Error', () => res.end());
        logger.error(`[${fip}] ${err.stack}`);
    }
});

// return information about queried course
app.get('/search', async (req, res) => {
    const ip = (req.headers['cf-connecting-ip'] || req.ip);
    const fip = ip.split(ip.length>15?':':'.').map(n => ('000'+n).slice(ip.length>15?-4:-3)).join(ip.length>15?':':'.');
    try {
        // check if we received both search parameters
        if(req.query['d'] && req.query['c']) {
            const dep = req.query['d'].replace(/[^a-zA-Z\d:]/g,'').toUpperCase().substring(0, 4);
            const course = req.query['c'].replace(/[^a-zA-Z\d:]/g,'').toUpperCase().substring(0, 3);
            const queryString = dep+course;

            // check for cached response
            if (RESPONSE_CACHE[queryString]) {
                res.status(200).json(RESPONSE_CACHE[queryString]).end();
                logger.info(`[${fip}] [✔️  Cached] [GET /search] [${queryString}]`);

            // generate and cache response
            } else {
                const conn = await mysql2.createConnection(config.databaseSettings);
                const [rows] = await conn.execute(`SELECT year,semester,professorName,section,honors,avgGPA,numA,numB,numC,numD,numF,numI,numS,numU,numQ,numX FROM ${config.gradesTable} WHERE (departmentName="${dep}") AND (course="${course}");`);
                await conn.end();

                RESPONSE_CACHE[queryString] = rows;
                res.status(200).json(RESPONSE_CACHE[queryString]).end();
                logger.info(`[${fip}] [${rows.length>0?'✔️':'❌'} Queried] [GET /search] [${queryString}]`);
            }

        // missing some search parameters, send client an error
        } else {
            res.write('Frontend Error: Missing departmentName or course', () => res.end());
            logger.info(`[${fip}] [❌ Missing Search Parameters] [GET ${req.url}]`);
        }

    // catch and log errors, notify frontend
    } catch (err) {
        logger.error(`[${fip}] ${err.stack}`);
        res.write('Backend Error', () => res.end());
    }
});

// default all other requests to the 404 page
app.use(async (req, res) => {
    res.status(404).sendFile('public/404.html', { root: __dirname });
    const ip = (req.headers['cf-connecting-ip'] || req.ip);
    const fip = ip.split(ip.length>15?':':'.').map(n => ('000'+n).slice(ip.length>15?-4:-3)).join(ip.length>15?':':'.');
    logger.info(`[${fip}] [❌ 404] [GET ${req.url}]`);
});

// start the server
app.listen(config.port, () => logger.info(`Server running on port: ${config.port}`));

// handle sigint
process.on('SIGINT', () => {
    logger.info('Gracefully shutting down from SIGINT (Ctrl-C)\n');
    process.exit(0);
});