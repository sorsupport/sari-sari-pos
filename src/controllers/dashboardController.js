const { query } = require('../config/db');
const { STORE_TZ, storeToday } = require('../utils/helpers');

const RANGES = {
  today: { days: 1, label: 'Today', compare: 'vs yesterday' },
  '7d': { days: 7, label: '7 days', compare: 'vs last week' },
  '30d': { days: 30, label: '30 days', compare: 'vs prior 30 days' },
};

// Sales on store-local dates [from, to], written so the created_at index still applies.
// $1 is always the store timezone.
function inDates(col, fromParam, toParam) {
  return `${col} >= (${fromParam}::date)::timestamp AT TIME ZONE $1
      AND ${col} < (${toParam}::date + 1)::timestamp AT TIME ZONE $1`;
}

async function periodStats(from, to) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(total_amount), 0) AS revenue,
            COUNT(*)::int AS orders,
            COALESCE((SELECT SUM(si.quantity) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                      WHERE s.status = 'completed' AND ${inDates('s.created_at', '$2', '$3')}), 0)::int AS items
     FROM sales
     WHERE status = 'completed' AND ${inDates('created_at', '$2', '$3')}`,
    [STORE_TZ, from, to]
  );
  const r = rows[0];
  return { revenue: r.revenue, orders: r.orders, items: r.items, aov: r.orders ? r.revenue / r.orders : 0 };
}

function change(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

async function dashboard(req, res, next) {
  const rangeKey = RANGES[req.query.range] ? req.query.range : '7d';
  const range = RANGES[rangeKey];
  const to = storeToday();
  const from = storeToday(-(range.days - 1));
  const prevTo = storeToday(-range.days);
  const prevFrom = storeToday(-(range.days * 2 - 1));
  const from30 = storeToday(-29);

  try {
    const trendSql =
      rangeKey === 'today'
        ? `SELECT h AS key, COALESCE(SUM(s.total_amount), 0) AS total
           FROM generate_series(0, 23) h
           LEFT JOIN sales s ON s.status = 'completed' AND ${inDates('s.created_at', '$2', '$3')}
                AND EXTRACT(HOUR FROM s.created_at AT TIME ZONE $1) = h
           GROUP BY h ORDER BY h`
        : `SELECT to_char(d, 'YYYY-MM-DD') AS key, COALESCE(SUM(s.total_amount), 0) AS total
           FROM generate_series($2::date, $3::date, INTERVAL '1 day') d
           LEFT JOIN sales s ON s.status = 'completed'
                AND s.created_at >= d::timestamp AT TIME ZONE $1
                AND s.created_at < (d + INTERVAL '1 day')::timestamp AT TIME ZONE $1
           GROUP BY d ORDER BY d`;

    const [current, previous, trendRows, categoryRows, topProducts, lowStock, recentSales] = await Promise.all([
      periodStats(from, to),
      periodStats(prevFrom, prevTo),
      query(trendSql, [STORE_TZ, from, to]).then((r) => r.rows),
      query(
        `SELECT COALESCE(c.name, 'Uncategorized') AS name, SUM(si.subtotal) AS revenue
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products p ON p.id = si.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE s.status = 'completed' AND ${inDates('s.created_at', '$2', '$3')}
         GROUP BY 1 ORDER BY 2 DESC`,
        [STORE_TZ, from30, to]
      ).then((r) => r.rows),
      query(
        `SELECT si.product_id, si.product_name AS name, SUM(si.quantity)::int AS units, SUM(si.subtotal) AS revenue,
                MAX(c.name) AS category, MAX(pi.updated_at) AS image_updated_at
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products p ON p.id = si.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN product_images pi ON pi.product_id = si.product_id
         WHERE s.status = 'completed' AND ${inDates('s.created_at', '$2', '$3')}
         GROUP BY si.product_id, si.product_name
         ORDER BY revenue DESC
         LIMIT 4`,
        [STORE_TZ, from30, to]
      ).then((r) => r.rows),
      query(
        `SELECT p.id, p.name, p.stock_quantity, p.reorder_level, c.name AS category
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.active = TRUE AND p.stock_quantity <= p.reorder_level
         ORDER BY p.stock_quantity ASC, p.name`
      ).then((r) => r.rows),
      query(
        `SELECT id, receipt_no, created_at, total_amount, payment_method, status
         FROM sales WHERE ${inDates('created_at', '$2', '$2')}
         ORDER BY created_at DESC LIMIT 5`,
        [STORE_TZ, to]
      ).then((r) => r.rows),
    ]);

    // Chart: hourly for today (store hours, widened to any hour with sales), daily otherwise.
    let trend;
    if (rangeKey === 'today') {
      const withSales = trendRows.filter((r) => r.total > 0).map((r) => r.key);
      const first = Math.min(8, ...withSales);
      const last = Math.max(21, ...withSales);
      trend = trendRows
        .filter((r) => r.key >= first && r.key <= last)
        .map((r) => ({
          label: `${r.key % 12 || 12} ${r.key < 12 ? 'AM' : 'PM'}`,
          long: `${r.key % 12 || 12} ${r.key < 12 ? 'AM' : 'PM'}`,
          total: r.total,
        }));
    } else {
      trend = trendRows.map((r) => {
        const d = new Date(`${r.key}T00:00:00Z`);
        return {
          label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
          long: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
          total: r.total,
        };
      });
    }
    const peak = trend.reduce((best, t) => (t.total > (best ? best.total : 0) ? t : best), null);

    // Category share: top five, the rest folded into "Other".
    const categoryTotal = categoryRows.reduce((sum, r) => sum + r.revenue, 0);
    let categories = categoryRows.slice(0, 5);
    const rest = categoryRows.slice(5).reduce((sum, r) => sum + r.revenue, 0);
    if (rest > 0) categories.push({ name: 'Other', revenue: rest });
    categories = categories.map((c) => ({ ...c, share: categoryTotal ? (c.revenue / categoryTotal) * 100 : 0 }));

    res.render('admin/dashboard', {
      title: 'Dashboard',
      rangeKey,
      range,
      from,
      to,
      kpis: {
        revenue: { value: current.revenue, change: change(current.revenue, previous.revenue) },
        orders: { value: current.orders, change: change(current.orders, previous.orders) },
        aov: { value: current.aov, change: change(current.aov, previous.aov) },
        items: { value: current.items, change: change(current.items, previous.items) },
      },
      trend,
      peak,
      categories,
      topProducts,
      lowStock,
      recentSales,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { dashboard };
