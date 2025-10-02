// Liste des symboles à exclure de la recherche (à personnaliser)
const excludeSymbols = ['XCADUSDT', 'VOLTUSDT','SETF1001USDT','SBTCSUSDT','MCHUSDT','OLASUSDT',
    'SLNUSDT','ARTFIUSDT','SXRPSUSDT','PREMARKET3USDT','CARUSDT','LOTUSDT','TESTZEUSUSDT',
   
    'PNTUSDT','CREAMUSDT','AMBUSDT','WRXUSDT','LTOUSDT','MDXUSDT'
];

// Node.js backend logic for both Binance and Bitget
const fs = require('fs');
const https = require('https');

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Routes API pour Render
app.get('/binance', (req, res) => {
    res.set('Content-Type', 'text/plain');
    fs.readFile(__dirname + '/binance.txt', 'utf8', (err, data) => {
        if (err) return res.status(404).send('Aucune donnée');
        res.send(data);
    });
});
app.get('/bitget', (req, res) => {
    res.set('Content-Type', 'text/plain');
    fs.readFile(__dirname + '/bitget.txt', 'utf8', (err, data) => {
        if (err) return res.status(404).send('Aucune donnée');
        res.send(data);
    });
});
app.get('/', (req, res) => res.send('API Crypto OK'));

app.listen(PORT, () => {
    console.log('Serveur Express démarré sur le port', PORT);
});

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
    try {
        const json = await fetchJson(platform.symbolsUrl);
        if (platform.name === 'binance') {
            console.log('[DEBUG Binance] Réponse API:', JSON.stringify(json).slice(0, 500));
        }
        return platform.extractSymbols(json);
    } catch (err) {
        if (platform.name === 'binance') {
            console.error('[DEBUG Binance] Erreur fetchSymbols:', err);
        }
        return [];
    }
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
        console.log(`[${platform.name}] Récupération des symboles...`);
        const symbols = await fetchSymbols(platform);
        if (!symbols || symbols.length === 0) {
            console.error(`[${platform.name}] Aucun symbole récupéré.`);
            return;
        }
        const results = [];
        let naCount = 0;
        const batchSize = platform.batchSize || 40;
        for (let i = 0; i < symbols.length; i += batchSize) {
            const batch = symbols.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map(symbol => getPriceAndVariation(platform, symbol)));
            batchResults.forEach(res => {
                if (res.price === 'N/A' || res.variation === 'N/A') naCount++;
                results.push(`${res.symbol},${res.price},${res.variation}`);
            });
        }
        fs.writeFileSync(platform.outputFile, results.join('\n') + '\n', 'utf8');
        console.log(`[${platform.name}] Fichier ${platform.outputFile} écrit (${results.length} cryptos).`);
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
    while (true) {
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
        await sleep(1000);
    }
}

async function updateAllCustom(platform, symbols) {
    try {
        console.log(`[${platform.name}] Récupération des symboles...`);
        if (!symbols || symbols.length === 0) {
            console.error(`[${platform.name}] Aucun symbole à traiter.`);
            return;
        }
        let results = [];
        let naSymbols = [];
        const batchSize = platform.batchSize || 40;
        // Première passe
        for (let i = 0; i < symbols.length; i += batchSize) {
            const batch = symbols.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map(symbol => getPriceAndVariation(platform, symbol)));
            batchResults.forEach(res => {
                if (res.price === 'N/A' || res.variation === 'N/A') {
                    naSymbols.push(res.symbol);
                }
                results.push(`${res.symbol},${res.price},${res.variation}`);
            });
        }
        // Deuxième passe pour les N/A
        if (naSymbols.length > 0) {
            console.log(`[${platform.name}] Nouvelle tentative pour ${naSymbols.length} symboles N/A...`);
            let retryResults = [];
            for (let i = 0; i < naSymbols.length; i += batchSize) {
                const batch = naSymbols.slice(i, i + batchSize);
                const batchResults = await Promise.all(batch.map(symbol => getPriceAndVariation(platform, symbol)));
                retryResults.push(...batchResults);
            }
            // Remplace les anciennes valeurs N/A par les nouvelles
            results = results.map(line => {
                const [sym, price, variation] = line.split(',');
                if (naSymbols.includes(sym)) {
                    const found = retryResults.find(r => r.symbol === sym);
                    if (found && found.price !== 'N/A' && found.variation !== 'N/A') {
                        return `${found.symbol},${found.price},${found.variation}`;
                    }
                }
                return line;
            });
        }
        // Compte final des N/A
        let naCount = results.filter(line => line.includes('N/A')).length;
        fs.writeFileSync(platform.outputFile, results.join('\n') + '\n', 'utf8');
        console.log(`[${platform.name}] Fichier ${platform.outputFile} écrit (${results.length} cryptos).`);
        console.log(`[${platform.name}] Nombre de N/A : ${naCount}`);
    } catch (err) {
        console.error(`[${platform.name}] Erreur dans updateAll:`, err);
    }
}

mainPrioritaire();
