// Liste des symboles à exclure de la recherche (à personnaliser)
const excludeSymbols = ['XCADUSDT', 'VOLTUSDT','SETF1001USDT','SBTCSUSDT','MCHUSDT','OLASUSDT',
    'SLNUSDT','ARTFIUSDT','SXRPSUSDT','PREMARKET3USDT','CARUSDT','LOTUSDT','TESTZEUSUSDT',
   
    'PNTUSDT','CREAMUSDT','AMBUSDT','WRXUSDT','LTOUSDT','MDXUSDT'
];

// Node.js backend logic for both Binance and Bitget

const fs = require('fs');
const https = require('https');

const mysql = require('mysql2/promise');
require('dotenv').config();

// Configuration de la base MySQL via .env
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
};

// Création de la table si elle n'existe pas
async function ensureTableExists() {
    const connection = await mysql.createConnection(dbConfig);
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS prices (
            id INT AUTO_INCREMENT PRIMARY KEY,
            platform VARCHAR(20),
            symbol VARCHAR(30),
            price DECIMAL(30,10),
            variation VARCHAR(20),
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY unique_symbol_platform (platform, symbol)
        ) ENGINE=InnoDB;
    `);
    await connection.end();
}

const platforms = [
    {
        name: 'binance',
        symbolsUrl: 'https://api.binance.com/api/v3/ticker/price',
        candleUrl: symbol => `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=5`,
        extractSymbols: json => Array.isArray(json) ? json.map(item => item.symbol).filter(s => s.endsWith('USDT')) : [],
        extractCandles: json => Array.isArray(json) ? json : [],
        outputFile: __dirname + '/binance.txt',
        batchSize: 20
    },
    {
        name: 'bitget',
        symbolsUrl: 'https://api.bitget.com/api/v3/market/tickers?category=SPOT',
        candleUrl: symbol => `https://api.bitget.com/api/v3/market/candles?category=SPOT&symbol=${symbol}&interval=1m&limit=5`,
        extractSymbols: json => (json.data && Array.isArray(json.data)) ? json.data.map(item => item.symbol).filter(s => s.endsWith('USDT')) : [],
        extractCandles: json => (json.data && Array.isArray(json.data)) ? json.data : [],
        outputFile: __dirname + '/bitget.txt',
        batchSize: 20
    }
];

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject('Erreur de parsing JSON: ' + e);
                }
            });
        }).on('error', err => reject('Erreur de requête HTTPS: ' + err));
    });
}

async function fetchSymbols(platform) {
    const json = await fetchJson(platform.symbolsUrl);
    return platform.extractSymbols(json);
}

async function getPriceAndVariation(platform, symbol) {
    try {
        const json = await fetchJson(platform.candleUrl(symbol));
        const candles = platform.extractCandles(json);
        if (candles.length >= 2) {
            let price, prevPrice;
            // Prendre le premier et le dernier du tableau pour TOUTES les plateformes
            const first = candles[0];
            const last = candles[candles.length - 1];
            price = parseFloat(last[4]);
            prevPrice = parseFloat(first[4]);
            const variation = prevPrice !== 0 ? (((price - prevPrice) / prevPrice) * 100).toFixed(2) + '%' : 'N/A';
            return { symbol, price, variation };
        }
        return { symbol, price: 'N/A', variation: 'N/A' };
    } catch {
        return { symbol, price: 'N/A', variation: 'N/A' };
    }
}


async function updateAll(platform) {
    try {
        await ensureTableExists();
        console.log(`[${platform.name}] Récupération des symboles...`);
        const symbols = await fetchSymbols(platform);
        if (!symbols || symbols.length === 0) {
            console.error(`[${platform.name}] Aucun symbole récupéré.`);
            return;
        }
        let naCount = 0;
        const batchSize = platform.batchSize || 40;
        const connection = await mysql.createConnection(dbConfig);
        for (let i = 0; i < symbols.length; i += batchSize) {
            const batch = symbols.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map(symbol => getPriceAndVariation(platform, symbol)));
            for (const res of batchResults) {
                if (res.price === 'N/A' || res.variation === 'N/A') naCount++;
                await connection.execute(
                    `REPLACE INTO prices (platform, symbol, price, variation) VALUES (?, ?, ?, ?)`,
                    [platform.name, res.symbol, res.price !== 'N/A' ? res.price : null, res.variation]
                );
            }
        }
        await connection.end();
        console.log(`[${platform.name}] Données enregistrées en base (${symbols.length} cryptos).`);
        console.log(`[${platform.name}] Nombre de N/A : ${naCount}`);
    } catch (err) {
        console.error(`[${platform.name}] Erreur dans updateAll:`, err);
    }
}

// Lancer pour chaque plateforme
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


// Nouvelle logique de priorité A-K Binance, L-Z Bitget
function getFirstLetter(symbol) {
    return symbol[0].toUpperCase();
}

function isAtoK(symbol) {
    const c = getFirstLetter(symbol);
    return c >= 'A' && c <= 'N';
}

function isLtoZ(symbol) {
    const c = getFirstLetter(symbol);
    return c >= 'O' && c <= 'Z';
}

async function mainPrioritaire() {
    // 1. Récupérer tous les symboles de chaque plateforme
    const allSymbols = {};
    for (const platform of platforms) {
        allSymbols[platform.name] = await fetchSymbols(platform);
    }

    // 2. Déterminer la plateforme prioritaire pour chaque symbole
    const setBinance = new Set(allSymbols.binance);
    const setBitget = new Set(allSymbols.bitget);
    const allUnique = new Set([...setBinance, ...setBitget]);

    // 3. Répartir les symboles selon la règle, en excluant ceux de excludeSymbols
    const toBinance = [];
    const toBitget = [];
    for (const symbol of allUnique) {
        if (excludeSymbols.includes(symbol)) continue;
        const inBinance = setBinance.has(symbol);
        const inBitget = setBitget.has(symbol);
        if (inBinance && inBitget) {
            if (isAtoK(symbol)) {
                toBinance.push(symbol);
            } else {
                toBitget.push(symbol);
            }
        } else if (inBinance) {
            toBinance.push(symbol);
        } else if (inBitget) {
            toBitget.push(symbol);
        }
    }

    // 4. Mettre à jour chaque plateforme avec uniquement les symboles à traiter
    await Promise.all([
        updateAllCustom(platforms[0], toBinance),
        updateAllCustom(platforms[1], toBitget)
    ]);
    // Le script s'arrête après une seule recherche
}


async function updateAllCustom(platform, symbols) {
    try {
        await ensureTableExists();
        console.log(`[${platform.name}] Récupération des symboles...`);
        if (!symbols || symbols.length === 0) {
            console.error(`[${platform.name}] Aucun symbole à traiter.`);
            return;
        }
        let naSymbols = [];
        const batchSize = platform.batchSize || 40;
        const connection = await mysql.createConnection(dbConfig);
        // Première passe
        for (let i = 0; i < symbols.length; i += batchSize) {
            const batch = symbols.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map(symbol => getPriceAndVariation(platform, symbol)));
            for (const res of batchResults) {
                if (res.price === 'N/A' || res.variation === 'N/A') {
                    naSymbols.push(res.symbol);
                }
                await connection.execute(
                    `REPLACE INTO prices (platform, symbol, price, variation) VALUES (?, ?, ?, ?)`,
                    [platform.name, res.symbol, res.price !== 'N/A' ? res.price : null, res.variation]
                );
            }
        }
        // Deuxième passe pour les N/A
        if (naSymbols.length > 0) {
            console.log(`[${platform.name}] Nouvelle tentative pour ${naSymbols.length} symboles N/A...`);
            for (let i = 0; i < naSymbols.length; i += batchSize) {
                const batch = naSymbols.slice(i, i + batchSize);
                const batchResults = await Promise.all(batch.map(symbol => getPriceAndVariation(platform, symbol)));
                for (const res of batchResults) {
                    await connection.execute(
                        `REPLACE INTO prices (platform, symbol, price, variation) VALUES (?, ?, ?, ?)`,
                        [platform.name, res.symbol, res.price !== 'N/A' ? res.price : null, res.variation]
                    );
                }
            }
        }
        await connection.end();
        // Compte final des N/A
        // (optionnel: tu peux faire un SELECT COUNT(*) WHERE price IS NULL)
        let naCount = naSymbols.length;
        console.log(`[${platform.name}] Données enregistrées en base (${symbols.length} cryptos).`);
        console.log(`[${platform.name}] Nombre de N/A : ${naCount}`);
    } catch (err) {
        console.error(`[${platform.name}] Erreur dans updateAll:`, err);
    }
}

mainPrioritaire();
