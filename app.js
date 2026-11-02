/**
 * ==============================================================================
 * Лабораторна робота №2: Асинхронна взаємодія із API
 * Варіант 5: Конвертер валют (ExchangeRate API)
 * ==============================================================================
 */

// Отримуємо посилання на елементи DOM
const amountInput = document.getElementById('amount-input');
const baseSelect = document.getElementById('base-currency');
const targetSelect = document.getElementById('target-currency');
const swapBtn = document.getElementById('swap-btn');

const resultDisplay = document.getElementById('result-display');
const rateInfo = document.getElementById('rate-info');
const lastUpdate = document.getElementById('last-update');
const loadingSpinner = document.getElementById('loading-spinner');
const errorMessage = document.getElementById('error-message');

let chartInstance = null; // Змінна для зберігання екземпляра Chart.js
let cachedRates = null;   // КЕШ: зберігає останній отриманий об'єкт курсів, щоб не смикати API при кожній цифрі

/**
 * 1. ФУНКЦІЯ: fetchRates
 * Призначення: Виконує HTTP GET-запит за актуальними курсами валют.
 * @param {string} base - Базова валюта (наприклад, 'USD')
 * @returns {Promise<Object>} - Об'єкт відповіді сервера з курсами у форматі JSON
 */
async function fetchRates(base) {
    const url = `https://open.er-api.com/v6/latest/${base}`;
    const response = await fetch(url);
    
    // Перевірка HTTP статусу (200-299)
    if (!response.ok) {
        throw new Error(`Помилка API (${response.status}): ${response.statusText}`);
    }
    
    // response.json() асинхронно зчитує тіло відповіді та парсить JSON
    const data = await response.json();
    return data;
}

/**
 * 2. ФУНКЦІЯ: fetchHistoricalRates
 * Призначення: Отримує курси за останні 7 днів для побудови графіка (Chart.js).
 * @param {string} base - Базова валюта
 * @param {string} target - Цільова валюта
 * @returns {Promise<{dates: string[], values: number[]}>}
 */
async function fetchHistoricalRates(base, target) {
    if (base === target) {
        const today = new Date().toISOString().split('T')[0];
        return { dates: [today], values: [1] };
    }

    // Якщо одна з валют — Гривня (UAH):
    // Європейський центробанк (Frankfurter) не веде курс UAH.
    // Тому для гривні звертаємось до офіційного API НБУ (bank.gov.ua) через Promise.all
    if (base === 'UAH' || target === 'UAH') {
        const foreign = base === 'UAH' ? target : base;
        
        const datesToFetch = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            datesToFetch.push({
                raw: `${year}${month}${day}`, // формат YYYYMMDD для НБУ
                label: `${day}.${month}`      // короткий підпис для осі X
            });
        }

        // Робимо 7 паралельних запитів за 7 днів через Promise.all
        const promises = datesToFetch.map(async (item) => {
            const url = `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=${foreign}&date=${item.raw}&json`;
            const res = await fetch(url);
            if (!res.ok) return null;
            const data = await res.json();
            if (!data || !data[0]) return null;

            let rate = data[0].rate;
            if (base === 'UAH') {
                rate = 1 / rate; // обернений курс
            }
            return { label: item.label, rate: Number(rate.toFixed(4)) };
        });

        const results = await Promise.all(promises);
        const validResults = results.filter(r => r !== null);

        return {
            dates: validResults.map(r => r.label),
            values: validResults.map(r => r.rate)
        };
    }

    // Для решти міжнародних валют (USD, EUR, GBP, PLN, CHF) використовуємо Frankfurter API
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 7);

    const startDateStr = start.toISOString().split('T')[0];
    const endDateStr = end.toISOString().split('T')[0];

    const url = `https://api.frankfurter.dev/v1/${startDateStr}..${endDateStr}?from=${base}&to=${target}`;
    
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Не вдалося отримати історичні дані для графіка (${response.status})`);
    }

    const data = await response.json();
    const dates = Object.keys(data.rates);
    const values = dates.map(date => data.rates[date][target]);

    return { dates, values };
}

/**
 * 3. ФУНКЦІЯ: updateChart
 * Призначення: Ініціалізує або перемальовує графік динаміки курсу за тиждень.
 * @param {string[]} labels - Масив дат (вісь X)
 * @param {number[]} data - Масив курсів (вісь Y)
 * @param {string} targetCurrency - Код цільової валюти
 */
function updateChart(labels, data, targetCurrency) {
    const ctx = document.getElementById('rateChart').getContext('2d');

    // Якщо графік уже існує, знищуємо старий екземпляр перед створенням нового
    if (chartInstance) {
        chartInstance.destroy();
    }

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: `Курс до ${targetCurrency}`,
                data: data,
                borderColor: '#2a5298',
                backgroundColor: 'rgba(42, 82, 152, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true }
            },
            scales: {
                y: {
                    ticks: {
                        callback: value => value.toFixed(2)
                    }
                }
            }
        }
    });
}

/**
 * 4. ФУНКЦІЯ: recalculateAmountOnly
 * Призначення: Миттєво перераховує суму за вже збереженим (кешованим) курсом.
 * НЕ робить мережевих запитів і НЕ перемальовує графік (економія трафіку та CPU).
 */
function recalculateAmountOnly() {
    if (!cachedRates) return;

    const amount = parseFloat(amountInput.value) || 0;
    const base = baseSelect.value;
    const target = targetSelect.value;
    const rate = cachedRates.rates[target];

    if (!rate) return;

    const converted = (amount * rate).toFixed(2);
    resultDisplay.textContent = `${amount} ${base} = ${converted} ${target}`;
}

/**
 * 5. ФУНКЦІЯ: fetchAndRefreshAll
 * Призначення: Викликається ТІЛЬКИ при зміні валют або за таймером 5 хвилин.
 * Робить мережеві запити до API, кешує курси, оновлює UI та перемальовує графік за тиждень.
 */
async function fetchAndRefreshAll() {
    const base = baseSelect.value;
    const target = targetSelect.value;

    loadingSpinner.style.display = 'block';
    errorMessage.style.display = 'none';

    try {
        // Паралельні запити: свіжі курси + історія за 7 днів
        const [ratesResult, historyResult] = await Promise.allSettled([
            fetchRates(base),
            fetchHistoricalRates(base, target)
        ]);

        if (ratesResult.status === 'rejected') {
            throw ratesResult.reason;
        }

        // Зберігаємо актуальні курси в кеш та фіксуємо точний локальний час отримання відповіді
        cachedRates = ratesResult.value;
        cachedRates.lastFetchedAt = new Date().toLocaleTimeString();

        // 1. Оновлюємо розрахунок суми
        recalculateAmountOnly();

        // 2. Оновлюємо інформацію про курс та час оновлення
        const rate = cachedRates.rates[target];
        if (rate) {
            rateInfo.textContent = `1 ${base} = ${rate.toFixed(4)} ${target}`;
        }
        lastUpdate.textContent = `Останнє оновлення: ${cachedRates.lastFetchedAt}`;

        // 3. Оновлюємо графік за тиждень
        if (historyResult.status === 'fulfilled' && historyResult.value) {
            updateChart(historyResult.value.dates, historyResult.value.values, target);
        }

    } catch (err) {
        console.error('Помилка при завантаженні курсів:', err);
        errorMessage.textContent = `Помилка: ${err.message || 'Не вдалося виконати запит'}`;
        errorMessage.style.display = 'block';
    } finally {
        loadingSpinner.style.display = 'none';
    }
}

/**
 * 6. ФУНКЦІЯ: initRxJSPipeline
 * Призначення: Налаштовує реактивну обробку подій за допомогою RxJS.
 * Розділяє швидкий потік введення суми та важкий потік мережевих запитів.
 */
function initRxJSPipeline() {
    const { fromEvent, merge, interval } = rxjs;
    const debounceTime = rxjs.debounceTime || rxjs.operators.debounceTime;
    const switchMap = rxjs.switchMap || rxjs.operators.switchMap;
    const tap = rxjs.tap || rxjs.operators.tap;

    // ПОТІК 1: Введення суми користувачем
    // Не чіпає мережу і графік, а тільки миттєво перераховує число на екрані
    fromEvent(amountInput, 'input').pipe(
        debounceTime(150)
    ).subscribe(() => {
        recalculateAmountOnly();
    });

    // ПОТІК 2: Зміна валют або кнопки реверсу
    const baseChange$ = fromEvent(baseSelect, 'change');
    const targetChange$ = fromEvent(targetSelect, 'change');

    const swap$ = fromEvent(swapBtn, 'click').pipe(
        tap(() => {
            const temp = baseSelect.value;
            baseSelect.value = targetSelect.value;
            targetSelect.value = temp;
        })
    );

    // ПОТІК 3: Автооновлення кожні 5 хвилин (300 000 мс) за варіантом
    const autoRefresh$ = interval(300000);

    // Об'єднуємо всі події, що ВИМАГАЮТЬ звернення до мережі:
    merge(baseChange$, targetChange$, swap$, autoRefresh$).pipe(
        switchMap(() => fetchAndRefreshAll())
    ).subscribe();

    // Перший запуск одразу після відкриття сторінки
    fetchAndRefreshAll();
}

// Запуск програми після завантаження DOM
document.addEventListener('DOMContentLoaded', initRxJSPipeline);
