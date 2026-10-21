# Builds "storefront", an invented shop (Laravel API + Next.js web) with a year of Git history by invented people
# and coding agents, plus an agent's open branch (the pull request the launch film reviews).
# Usage: python3 make_storefront.py <out-dir>
import os, random, re, shutil, subprocess, sys
from datetime import datetime, timedelta

OUT = sys.argv[1]
PR_START = int(sys.argv[2]) if len(sys.argv) > 2 else 2700
rng = random.Random(7)

PEOPLE = {
    'ana': ('Ana Ruiz', 'ana@storefront.dev'),
    'tom': ('Tom Becker', 'tom@storefront.dev'),
    'priya': ('Priya Nair', 'priya@storefront.dev'),
    'leo': ('Leo Martin', 'leo@storefront.dev'),
    'sara': ('Sara Kim', 'sara@storefront.dev'),
    'jonas': ('Jonas Weber', 'jonas@storefront.dev'),
    'claude': ('Claude', 'noreply@anthropic.com'),
    'codex': ('Codex', 'codex@openai.com'),
    'cursor': ('Cursor Agent', 'cursoragent@cursor.com'),
}

# path -> {'head': str, 'parts': [str], 'tail': str}
FILES = {}
def put(path, head, parts, tail=''):
    FILES[path] = {'head': head, 'parts': list(parts), 'tail': tail}

def render(path, n=None):
    f = FILES[path]
    parts = f['parts'] if n is None else f['parts'][:n]
    return f['head'] + ''.join(parts) + f['tail']

def use_lines(names): return ''.join('use ' + n + ';' + chr(10) for n in names)

def use_models(models): return use_lines(['App' + chr(92) + 'Models' + chr(92) + m for m in models])

def snake(name):
    out = ''
    for i, ch in enumerate(name):
        if ch.isupper() and i: out += '_'
        out += ch.lower()
    return out

def plural(word):
    if word.endswith('y'): return word[:-1] + 'ies'
    if word.endswith('s'): return word + 'es'
    return word + 's'

def camel(name): return name[0].lower() + name[1:]

# ---------------------------------------------------------------------------------------------------------------- API
A = 'api/'
put(A + 'composer.json', '', ['''{
    "name": "storefront/api",
    "type": "project",
    "require": {
        "php": "^8.3",
        "laravel/framework": "^12.0",
        "laravel/sanctum": "^4.0",
        "stripe/stripe-php": "^16.0"
    },
    "autoload": { "psr-4": { "App\\\\": "app/", "Database\\\\Factories\\\\": "database/factories/", "Database\\\\Seeders\\\\": "database/seeders/" } }
}
'''])
put(A + 'bootstrap/app.php', '', ['''<?php

use Illuminate\\Foundation\\Application;
use Illuminate\\Foundation\\Configuration\\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__ . '/../routes/web.php',
        api: __DIR__ . '/../routes/api.php',
        commands: __DIR__ . '/../routes/console.php',
    )
    ->withMiddleware(function (Middleware $middleware) {
        $middleware->statefulApi();
    })
    ->create();
'''])
put(A + 'routes/web.php', '', ['''<?php

use Illuminate\\Support\\Facades\\Route;

Route::get('/', fn () => ['name' => 'storefront', 'status' => 'ok']);
'''])

# Models -----------------------------------------------------------------------------------------------------------
MODELS = {
    'User': (['name', 'email', 'password', 'is_admin'], [('customer', 'hasOne', 'Customer')]),
    'Customer': (['user_id', 'stripe_id', 'phone', 'marketing_opt_in'], [('user', 'belongsTo', 'User'), ('orders', 'hasMany', 'Order'), ('addresses', 'hasMany', 'Address'), ('reviews', 'hasMany', 'Review')]),
    'Category': (['name', 'slug', 'parent_id', 'position'], [('products', 'hasMany', 'Product'), ('parent', 'belongsTo', 'Category')]),
    'Product': (['category_id', 'name', 'slug', 'description', 'price_cents', 'currency', 'active'], [('category', 'belongsTo', 'Category'), ('variants', 'hasMany', 'ProductVariant'), ('reviews', 'hasMany', 'Review'), ('inventory', 'hasMany', 'InventoryLevel')]),
    'ProductVariant': (['product_id', 'sku', 'name', 'price_cents', 'weight_grams'], [('product', 'belongsTo', 'Product'), ('inventory', 'hasOne', 'InventoryLevel')]),
    'Cart': (['customer_id', 'token', 'currency', 'expires_at'], [('items', 'hasMany', 'CartItem'), ('customer', 'belongsTo', 'Customer')]),
    'CartItem': (['cart_id', 'product_variant_id', 'quantity', 'unit_price_cents'], [('cart', 'belongsTo', 'Cart'), ('variant', 'belongsTo', 'ProductVariant')]),
    'Order': (['customer_id', 'number', 'status', 'subtotal_cents', 'tax_cents', 'shipping_cents', 'total_cents', 'currency', 'placed_at'], [('items', 'hasMany', 'OrderItem'), ('customer', 'belongsTo', 'Customer'), ('payments', 'hasMany', 'Payment'), ('shipments', 'hasMany', 'Shipment'), ('refunds', 'hasMany', 'Refund')]),
    'OrderItem': (['order_id', 'product_variant_id', 'name', 'quantity', 'unit_price_cents'], [('order', 'belongsTo', 'Order'), ('variant', 'belongsTo', 'ProductVariant')]),
    'Payment': (['order_id', 'provider', 'intent_id', 'status', 'amount_cents', 'captured_at'], [('order', 'belongsTo', 'Order')]),
    'Shipment': (['order_id', 'carrier', 'service', 'tracking_number', 'label_url', 'shipped_at'], [('order', 'belongsTo', 'Order')]),
    'Address': (['customer_id', 'line1', 'line2', 'city', 'postcode', 'country', 'is_default'], [('customer', 'belongsTo', 'Customer')]),
    'Review': (['product_id', 'customer_id', 'rating', 'title', 'body', 'status'], [('product', 'belongsTo', 'Product'), ('customer', 'belongsTo', 'Customer')]),
    'WishlistItem': (['customer_id', 'product_id'], [('customer', 'belongsTo', 'Customer'), ('product', 'belongsTo', 'Product')]),
    'Refund': (['order_id', 'payment_id', 'amount_cents', 'reason', 'status'], [('order', 'belongsTo', 'Order'), ('payment', 'belongsTo', 'Payment')]),
    'InventoryLevel': (['product_variant_id', 'warehouse', 'on_hand', 'reserved'], [('variant', 'belongsTo', 'ProductVariant')]),
    'TaxRate': (['country', 'region', 'rate_bp', 'name'], []),
}
SCOPES = {
    'Product': ['''
    public function scopeActive(Builder $query): Builder
    {
        return $query->where('active', true);
    }
''', '''
    public function priceFor(?ProductVariant $variant = null): int
    {
        return $variant?->price_cents ?? $this->price_cents;
    }
'''],
    'Order': ['''
    public function isPaid(): bool
    {
        return $this->status === 'paid' || $this->status === 'shipped';
    }
''', '''
    public static function nextNumber(): string
    {
        return 'SF-' . now()->format('ymd') . '-' . str_pad((string) (static::count() + 1), 5, '0', STR_PAD_LEFT);
    }
'''],
    'Cart': ['''
    public function subtotalCents(): int
    {
        return $this->items->sum(fn (CartItem $item) => $item->quantity * $item->unit_price_cents);
    }
'''],
    'InventoryLevel': ['''
    public function available(): int
    {
        return max(0, $this->on_hand - $this->reserved);
    }
'''],
    'Review': ['''
    public function scopePublished(Builder $query): Builder
    {
        return $query->where('status', 'published');
    }
'''],
}
REL_TYPES = {'hasMany': 'HasMany', 'belongsTo': 'BelongsTo', 'hasOne': 'HasOne'}
for model, (fillable, rels) in MODELS.items():
    uses = sorted({REL_TYPES[k] for _, k, _ in rels})
    head = '<?php\n\nnamespace App\\Models;\n\n'
    if model in ('Product', 'Review'): head += 'use Illuminate\\Database\\Eloquent\\Builder;\n'
    head += 'use Illuminate\\Database\\Eloquent\\Factories\\HasFactory;\nuse Illuminate\\Database\\Eloquent\\Model;\n'
    head += ''.join(f'use Illuminate\\Database\\Eloquent\\Relations\\{u};\n' for u in uses)
    base = 'Authenticatable' if model == 'User' else 'Model'
    if model == 'User': head += 'use Illuminate\\Foundation\\Auth\\User as Authenticatable;\n'
    head += f'\nclass {model} extends {base}\n{{\n    use HasFactory;\n\n    protected $fillable = [{", ".join(repr(x) for x in fillable)}];\n'
    parts = []
    for rel, kind, target in rels:
        parts.append(f'''
    public function {rel}(): {REL_TYPES[kind]}
    {{
        return $this->{kind}({target}::class);
    }}
''')
    parts += SCOPES.get(model, [])
    put(f'{A}app/Models/{model}.php', head, parts, '}\n')

# Migrations --------------------------------------------------------------------------------------------------------
COLUMN_TYPES = {'_id': 'foreignId', '_cents': 'unsignedInteger', 'is_': 'boolean', '_at': 'timestamp', 'quantity': 'unsignedInteger', 'rating': 'unsignedTinyInteger', 'position': 'unsignedInteger', 'on_hand': 'integer', 'reserved': 'integer', 'rate_bp': 'unsignedInteger', 'weight_grams': 'unsignedInteger', 'active': 'boolean', 'marketing_opt_in': 'boolean', 'body': 'text', 'description': 'text'}
def column(name):
    if name in ('stripe_id', 'intent_id'): return f"            $table->string('{name}')->nullable();\n"
    if name in ('amount', 'max_redemptions'): return f"            $table->unsignedInteger('{name}')->nullable();\n"
    for key, kind in COLUMN_TYPES.items():
        if (key.startswith('_') and name.endswith(key)) or (key.endswith('_') and name.startswith(key)) or key == name:
            if kind == 'foreignId':
                table = plural(name[:-3]) if name != 'parent_id' else 'categories'
                if name == 'product_variant_id': table = 'product_variants'
                extra = '->nullable()' if name in ('parent_id', 'customer_id') else ''
                return f"            $table->foreignId('{name}'){extra}->constrained('{table}');\n"
            if kind == 'timestamp': return f"            $table->timestamp('{name}')->nullable();\n"
            if kind == 'boolean': return f"            $table->boolean('{name}')->default(false);\n"
            return f"            $table->{kind}('{name}');\n"
    return f"            $table->string('{name}');\n"
ORDER = ['User', 'Customer', 'Category', 'Product', 'ProductVariant', 'Cart', 'CartItem', 'Order', 'OrderItem', 'Payment', 'Shipment', 'Address', 'Review', 'WishlistItem', 'Refund', 'InventoryLevel', 'TaxRate']
MIGRATIONS = {}
for i, model in enumerate(ORDER):
    table = plural(snake(model))
    path = f'{A}database/migrations/2025_08_{i + 1:02d}_000000_create_{table}_table.php'
    MIGRATIONS[model] = path
    cols = ''.join(column(c) for c in MODELS[model][0] if not (model == 'User' and c == 'password'))
    if model == 'User': cols += "            $table->string('password');\n            $table->rememberToken();\n"
    put(path, '', [f'''<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{{
    public function up(): void
    {{
        Schema::create('{table}', function (Blueprint $table) {{
            $table->id();
{cols}            $table->timestamps();
        }});
    }}

    public function down(): void
    {{
        Schema::dropIfExists('{table}');
    }}
}};
'''])

# Services ----------------------------------------------------------------------------------------------------------
def service(path, ns, uses, cls, ctor, methods, doc=''):
    head = f'<?php\n\nnamespace {ns};\n\n' + ''.join(f'use {u};\n' for u in uses) + (f'\n{doc}' if doc else '\n') + f'class {cls}\n{{\n'
    if ctor: head += f'    public function __construct(\n{ctor}\n    ) {{}}\n'
    put(path, head, methods, '}\n')

service(A + 'app/Services/Checkout/CheckoutService.php', 'App\\Services\\Checkout',
        ['App\\Events\\OrderPlaced', 'App\\Models\\Cart', 'App\\Models\\Order', 'App\\Models\\OrderItem', 'App\\Services\\Inventory\\InventoryService', 'App\\Services\\Payments\\PaymentGateway', 'Illuminate\\Support\\Facades\\DB'],
        'CheckoutService',
        '        private PricingService $pricing,\n        private InventoryService $inventory,\n        private PaymentGateway $payments,',
        ['''
    /** Turns a cart into a paid order: prices it, reserves the stock, charges the card, records the order. */
    public function placeOrder(Cart $cart, array $details): Order
    {
        $totals = $this->pricing->totals($cart, $details['shipping_method']);
        $this->inventory->reserve($cart);

        $order = DB::transaction(function () use ($cart, $details, $totals) {
            $order = Order::create([
                'customer_id' => $cart->customer_id,
                'number' => Order::nextNumber(),
                'status' => 'pending',
                'subtotal_cents' => $totals->subtotal,
                'tax_cents' => $totals->tax,
                'shipping_cents' => $totals->shipping,
                'total_cents' => $totals->total,
                'currency' => $cart->currency,
                'placed_at' => now(),
            ]);
            $this->copyItems($cart, $order);
            return $order;
        });

        $this->payments->charge($order, $details['payment_method']);
        OrderPlaced::dispatch($order);
        $cart->delete();

        return $order;
    }
''', '''
    private function copyItems(Cart $cart, Order $order): void
    {
        foreach ($cart->items as $item) {
            OrderItem::create([
                'order_id' => $order->id,
                'product_variant_id' => $item->product_variant_id,
                'name' => $item->variant->product->name . ' – ' . $item->variant->name,
                'quantity' => $item->quantity,
                'unit_price_cents' => $item->unit_price_cents,
            ]);
        }
    }
''', '''
    public function quote(Cart $cart, string $shippingMethod): array
    {
        $totals = $this->pricing->totals($cart, $shippingMethod);
        return ['subtotal' => $totals->subtotal, 'tax' => $totals->tax, 'shipping' => $totals->shipping, 'total' => $totals->total];
    }
'''])
service(A + 'app/Services/Checkout/PricingService.php', 'App\\Services\\Checkout',
        ['App\\Models\\Cart', 'App\\Services\\Shipping\\ShippingQuotes'], 'PricingService',
        '        private TaxCalculator $taxes,\n        private ShippingQuotes $shipping,',
        ['''
    public function totals(Cart $cart, string $shippingMethod): Totals
    {
        $subtotal = $cart->subtotalCents();
        $shipping = $this->shipping->priceFor($cart, $shippingMethod);
        $tax = $this->taxes->forCart($cart, $subtotal + $shipping);

        return new Totals($subtotal, $tax, $shipping, $subtotal + $tax + $shipping);
    }
''', '''
    public function unitPrice(int $listCents, int $quantity): int
    {
        if ($quantity >= 10) {
            return (int) round($listCents * 0.9);
        }
        if ($quantity >= 5) {
            return (int) round($listCents * 0.95);
        }
        return $listCents;
    }
'''])
put(A + 'app/Services/Checkout/Totals.php', '', ['''<?php

namespace App\\Services\\Checkout;

final class Totals
{
    public function __construct(
        public readonly int $subtotal,
        public readonly int $tax,
        public readonly int $shipping,
        public readonly int $total,
    ) {}
}
'''])
service(A + 'app/Services/Checkout/TaxCalculator.php', 'App\\Services\\Checkout', ['App\\Models\\Cart', 'App\\Models\\TaxRate'], 'TaxCalculator', '',
        ['''
    public function forCart(Cart $cart, int $taxableCents): int
    {
        $address = $cart->customer?->addresses()->where('is_default', true)->first();
        if (! $address) {
            return 0;
        }
        return (int) round($taxableCents * $this->rateFor($address->country, $address->postcode) / 10000);
    }
''', '''
    public function rateFor(string $country, ?string $postcode = null): int
    {
        $rate = TaxRate::where('country', $country)
            ->when($postcode, fn ($query) => $query->where(fn ($q) => $q->whereNull('region')->orWhere('region', substr($postcode, 0, 2))))
            ->orderByDesc('region')
            ->first();
        return $rate?->rate_bp ?? 0;
    }
'''])
service(A + 'app/Services/Payments/PaymentGateway.php', 'App\\Services\\Payments', ['App\\Models\\Order', 'App\\Models\\Payment'], 'PaymentGateway',
        '        private StripeClient $stripe,',
        ['''
    public function charge(Order $order, string $paymentMethod): Payment
    {
        $intent = $this->stripe->createIntent($order->total_cents, $order->currency, $paymentMethod, ['order' => $order->number]);

        return Payment::create([
            'order_id' => $order->id,
            'provider' => 'stripe',
            'intent_id' => $intent['id'],
            'status' => $intent['status'],
            'amount_cents' => $order->total_cents,
        ]);
    }
''', '''
    public function capture(Payment $payment): Payment
    {
        $intent = $this->stripe->capture($payment->intent_id);
        $payment->update(['status' => $intent['status'], 'captured_at' => now()]);
        if ($intent['status'] === 'succeeded') {
            $payment->order->update(['status' => 'paid']);
        }
        return $payment;
    }
''', '''
    public function handleWebhook(array $event): void
    {
        $payment = Payment::where('intent_id', $event['data']['object']['id'])->first();
        if (! $payment) {
            return;
        }
        match ($event['type']) {
            'payment_intent.succeeded' => $this->capture($payment),
            'payment_intent.payment_failed' => $payment->update(['status' => 'failed']),
            default => null,
        };
    }
'''])
service(A + 'app/Services/Payments/StripeClient.php', 'App\\Services\\Payments', ['Illuminate\\Support\\Facades\\Http'], 'StripeClient', '',
        ['''
    public function createIntent(int $amount, string $currency, string $paymentMethod, array $metadata = []): array
    {
        return $this->post('payment_intents', ['amount' => $amount, 'currency' => $currency, 'payment_method' => $paymentMethod, 'confirm' => true, 'capture_method' => 'manual', 'metadata' => $metadata]);
    }
''', '''
    public function capture(string $intentId): array
    {
        return $this->post("payment_intents/{$intentId}/capture", []);
    }
''', '''
    public function refund(string $intentId, int $amount): array
    {
        return $this->post('refunds', ['payment_intent' => $intentId, 'amount' => $amount]);
    }
''', '''
    private function post(string $path, array $body): array
    {
        return Http::withToken(config('services.stripe.secret'))->asForm()->post("https://api.stripe.com/v1/{$path}", $body)->throw()->json();
    }
'''])
service(A + 'app/Services/Payments/RefundService.php', 'App\\Services\\Payments', ['App\\Models\\Order', 'App\\Models\\Refund'], 'RefundService',
        '        private StripeClient $stripe,',
        ['''
    public function refund(Order $order, int $amountCents, string $reason): Refund
    {
        $payment = $order->payments()->where('status', 'succeeded')->latest()->firstOrFail();
        $result = $this->stripe->refund($payment->intent_id, $amountCents);

        return Refund::create(['order_id' => $order->id, 'payment_id' => $payment->id, 'amount_cents' => $amountCents, 'reason' => $reason, 'status' => $result['status']]);
    }
''', '''
    public function refundable(Order $order): int
    {
        return $order->total_cents - (int) $order->refunds()->sum('amount_cents');
    }
'''])
service(A + 'app/Services/Inventory/InventoryService.php', 'App\\Services\\Inventory', ['App\\Models\\Cart', 'App\\Models\\InventoryLevel', 'App\\Models\\OrderItem'], 'InventoryService', '',
        ['''
    public function reserve(Cart $cart): void
    {
        foreach ($cart->items as $item) {
            $level = InventoryLevel::where('product_variant_id', $item->product_variant_id)->lockForUpdate()->firstOrFail();
            if ($level->available() < $item->quantity) {
                throw new OutOfStock($item->variant->sku);
            }
            $level->increment('reserved', $item->quantity);
        }
    }
''', '''
    public function release(OrderItem $item): void
    {
        InventoryLevel::where('product_variant_id', $item->product_variant_id)->decrement('reserved', $item->quantity);
    }
''', '''
    public function ship(OrderItem $item): void
    {
        InventoryLevel::where('product_variant_id', $item->product_variant_id)->decrement('on_hand', $item->quantity);
        $this->release($item);
    }
'''])
put(A + 'app/Services/Inventory/OutOfStock.php', '', ['''<?php

namespace App\\Services\\Inventory;

use RuntimeException;

class OutOfStock extends RuntimeException
{
    public function __construct(public readonly string $sku)
    {
        parent::__construct("{$sku} is out of stock");
    }
}
'''])
service(A + 'app/Services/Inventory/StockSync.php', 'App\\Services\\Inventory', ['App\\Models\\InventoryLevel', 'Illuminate\\Support\\Facades\\Http'], 'StockSync', '',
        ['''
    public function pull(string $warehouse): int
    {
        $levels = Http::get(config('shop.warehouses.' . $warehouse . '.url') . '/stock')->json('levels', []);
        foreach ($levels as $row) {
            InventoryLevel::updateOrCreate(['product_variant_id' => $row['variant'], 'warehouse' => $warehouse], ['on_hand' => $row['on_hand']]);
        }
        return count($levels);
    }
'''])
service(A + 'app/Services/Shipping/ShippingQuotes.php', 'App\\Services\\Shipping', ['App\\Models\\Cart'], 'ShippingQuotes', '',
        ['''
    public const METHODS = ['standard' => 495, 'express' => 1295, 'pickup' => 0];

    public function priceFor(Cart $cart, string $method): int
    {
        if ($method !== 'express' && $cart->subtotalCents() >= config('shop.free_shipping_cents', 7500)) {
            return 0;
        }
        return self::METHODS[$method] ?? self::METHODS['standard'];
    }
''', '''
    public function options(Cart $cart): array
    {
        return collect(self::METHODS)->keys()->map(fn (string $method) => ['method' => $method, 'price_cents' => $this->priceFor($cart, $method)])->all();
    }
'''])
service(A + 'app/Services/Shipping/LabelPrinter.php', 'App\\Services\\Shipping', ['App\\Models\\Order', 'App\\Models\\Shipment', 'Illuminate\\Support\\Facades\\Http'], 'LabelPrinter', '',
        ['''
    public function printFor(Order $order, string $carrier = 'dhl'): Shipment
    {
        $label = Http::withToken(config("services.{$carrier}.key"))->post(config("services.{$carrier}.url") . '/labels', ['reference' => $order->number])->json();

        return Shipment::create(['order_id' => $order->id, 'carrier' => $carrier, 'service' => 'parcel', 'tracking_number' => $label['tracking'], 'label_url' => $label['url']]);
    }
'''])
service(A + 'app/Services/Catalog/CatalogService.php', 'App\\Services\\Catalog', ['App\\Models\\Category', 'App\\Models\\Product', 'Illuminate\\Contracts\\Pagination\\LengthAwarePaginator'], 'CatalogService', '',
        ['''
    public function browse(?string $category, string $sort = 'popular'): LengthAwarePaginator
    {
        $query = Product::active()->with('variants');
        if ($category) {
            $query->whereIn('category_id', $this->categoryAndChildren($category));
        }
        $sorted = match ($sort) {
            'price' => $query->orderBy('price_cents'),
            'new' => $query->latest(),
            default => $query->withCount('reviews')->orderByDesc('reviews_count'),
        };
        return $sorted->paginate(24);
    }
''', '''
    private function categoryAndChildren(string $slug): array
    {
        $category = Category::where('slug', $slug)->firstOrFail();
        return Category::where('parent_id', $category->id)->pluck('id')->push($category->id)->all();
    }
''', '''
    public function bySlug(string $slug): Product
    {
        return Product::active()->with(['variants', 'category'])->where('slug', $slug)->firstOrFail();
    }
'''])
service(A + 'app/Services/Catalog/ProductImporter.php', 'App\\Services\\Catalog', ['App\\Models\\Product', 'App\\Models\\ProductVariant'], 'ProductImporter', '',
        ['''
    public function import(string $csvPath): int
    {
        $rows = array_map('str_getcsv', file($csvPath));
        $header = array_shift($rows);
        foreach ($rows as $row) {
            $this->upsert(array_combine($header, $row));
        }
        return count($rows);
    }
''', '''
    private function upsert(array $row): void
    {
        $product = Product::updateOrCreate(['slug' => $row['slug']], ['name' => $row['name'], 'price_cents' => (int) $row['price_cents'], 'category_id' => (int) $row['category_id'], 'active' => true]);
        ProductVariant::updateOrCreate(['sku' => $row['sku']], ['product_id' => $product->id, 'name' => $row['variant'], 'price_cents' => (int) $row['price_cents']]);
    }
'''])
service(A + 'app/Services/Search/SearchIndex.php', 'App\\Services\\Search', ['App\\Models\\Product', 'Illuminate\\Support\\Facades\\Http'], 'SearchIndex', '',
        ['''
    public function search(string $query, int $limit = 20): array
    {
        $hits = Http::post(config('shop.search.url') . '/indexes/products/search', ['q' => $query, 'limit' => $limit])->json('hits', []);
        return Product::whereIn('id', array_column($hits, 'id'))->get()->all();
    }
''', '''
    public function index(Product $product): void
    {
        Http::put(config('shop.search.url') . '/indexes/products/documents', [['id' => $product->id, 'name' => $product->name, 'description' => $product->description]]);
    }
''', '''
    public function rebuild(): int
    {
        $count = 0;
        Product::active()->chunk(500, function ($products) use (&$count) {
            foreach ($products as $product) {
                $this->index($product);
                $count++;
            }
        });
        return $count;
    }
'''])
service(A + 'app/Services/Cart/CartService.php', 'App\\Services\\Cart', ['App\\Models\\Cart', 'App\\Models\\CartItem', 'App\\Models\\ProductVariant', 'App\\Services\\Checkout\\PricingService', 'Illuminate\\Support\\Str'], 'CartService',
        '        private PricingService $pricing,',
        ['''
    public function current(?string $token, ?int $customerId = null): Cart
    {
        return Cart::firstOrCreate(['token' => $token ?? Str::uuid()->toString()], ['customer_id' => $customerId, 'currency' => 'EUR', 'expires_at' => now()->addDays(14)]);
    }
''', '''
    public function add(Cart $cart, int $variantId, int $quantity): CartItem
    {
        $variant = ProductVariant::findOrFail($variantId);
        $item = $cart->items()->firstOrNew(['product_variant_id' => $variant->id]);
        $item->quantity = ($item->quantity ?? 0) + $quantity;
        $item->unit_price_cents = $this->pricing->unitPrice($variant->price_cents, $item->quantity);
        $item->save();
        return $item;
    }
''', '''
    public function remove(Cart $cart, int $itemId): void
    {
        $cart->items()->whereKey($itemId)->delete();
    }
'''])
service(A + 'app/Services/Reviews/ReviewModeration.php', 'App\\Services\\Reviews', ['App\\Models\\Review'], 'ReviewModeration', '',
        ['''
    private const BLOCKED = ['http://', 'https://', 'free money'];

    public function moderate(Review $review): Review
    {
        $flagged = collect(self::BLOCKED)->contains(fn (string $word) => str_contains(strtolower($review->body), $word));
        $review->update(['status' => $flagged ? 'held' : 'published']);
        return $review;
    }
'''])
service(A + 'app/Services/Reports/SalesReport.php', 'App\\Services\\Reports', ['App\\Models\\Order', 'Carbon\\CarbonImmutable'], 'SalesReport', '',
        ['''
    public function daily(CarbonImmutable $day): array
    {
        $orders = Order::whereBetween('placed_at', [$day->startOfDay(), $day->endOfDay()])->where('status', '!=', 'cancelled');
        return ['day' => $day->toDateString(), 'orders' => $orders->count(), 'revenue_cents' => (int) $orders->sum('total_cents')];
    }
''', '''
    public function range(CarbonImmutable $from, CarbonImmutable $to): array
    {
        $days = [];
        for ($day = $from; $day <= $to; $day = $day->addDay()) {
            $days[] = $this->daily($day);
        }
        return $days;
    }
'''])
service(A + 'app/Services/Customers/CustomerService.php', 'App\\Services\\Customers', ['App\\Models\\Customer', 'App\\Models\\User', 'Illuminate\\Support\\Facades\\Hash'], 'CustomerService', '',
        ['''
    public function register(array $data): Customer
    {
        $user = User::create(['name' => $data['name'], 'email' => $data['email'], 'password' => Hash::make($data['password'])]);
        return Customer::create(['user_id' => $user->id, 'marketing_opt_in' => $data['marketing_opt_in'] ?? false]);
    }
''', '''
    public function forget(Customer $customer): void
    {
        $customer->addresses()->delete();
        $customer->user->update(['name' => 'Deleted customer', 'email' => "deleted-{$customer->id}@storefront.invalid"]);
    }
'''])

# Http: requests, resources, controllers ----------------------------------------------------------------------------
REQUESTS = {
    'PlaceOrderRequest': "'shipping_method' => ['required', 'in:standard,express,pickup'], 'payment_method' => ['required', 'string']",
    'AddCartItemRequest': "'variant_id' => ['required', 'integer', 'exists:product_variants,id'], 'quantity' => ['required', 'integer', 'min:1', 'max:50']",
    'StoreReviewRequest': "'rating' => ['required', 'integer', 'between:1,5'], 'title' => ['required', 'max:120'], 'body' => ['required', 'max:4000']",
    'UpdateProductRequest': "'name' => ['sometimes', 'max:200'], 'price_cents' => ['sometimes', 'integer', 'min:0'], 'active' => ['sometimes', 'boolean']",
    'RegisterRequest': "'name' => ['required'], 'email' => ['required', 'email', 'unique:users'], 'password' => ['required', 'min:10']",
    'RefundRequest': "'amount_cents' => ['required', 'integer', 'min:1'], 'reason' => ['required', 'max:500']",
    'StoreAddressRequest': "'line1' => ['required'], 'city' => ['required'], 'postcode' => ['required'], 'country' => ['required', 'size:2']",
}
for name, rules in REQUESTS.items():
    put(f'{A}app/Http/Requests/{name}.php', '', [f'''<?php

namespace App\\Http\\Requests;

use Illuminate\\Foundation\\Http\\FormRequest;

class {name} extends FormRequest
{{
    public function rules(): array
    {{
        return [{rules}];
    }}
}}
'''])
RESOURCES = {
    'ProductResource': "'id' => $this->id, 'name' => $this->name, 'slug' => $this->slug, 'price_cents' => $this->price_cents, 'variants' => $this->whenLoaded('variants')",
    'OrderResource': "'number' => $this->number, 'status' => $this->status, 'total_cents' => $this->total_cents, 'currency' => $this->currency, 'items' => $this->whenLoaded('items')",
    'CartResource': "'token' => $this->token, 'items' => $this->items, 'subtotal_cents' => $this->subtotalCents()",
    'ReviewResource': "'rating' => $this->rating, 'title' => $this->title, 'body' => $this->body, 'author' => $this->customer?->user?->name",
    'CategoryResource': "'name' => $this->name, 'slug' => $this->slug",
    'CustomerResource': "'name' => $this->user->name, 'email' => $this->user->email, 'addresses' => $this->addresses",
}
for name, body in RESOURCES.items():
    put(f'{A}app/Http/Resources/{name}.php', '', [f'''<?php

namespace App\\Http\\Resources;

use Illuminate\\Http\\Request;
use Illuminate\\Http\\Resources\\Json\\JsonResource;

class {name} extends JsonResource
{{
    public function toArray(Request $request): array
    {{
        return [{body}];
    }}
}}
'''])
put(A + 'app/Http/Controllers/Controller.php', '', ['''<?php

namespace App\\Http\\Controllers;

abstract class Controller
{
}
'''])

def controller(path, ns, uses, cls, ctor, methods):
    head = f'<?php\n\nnamespace {ns};\n\n' + ''.join(f'use {u};\n' for u in sorted(set(uses))) + f'\nclass {cls} extends Controller\n{{\n'
    if ctor: head += f'    public function __construct(\n{ctor}\n    ) {{}}\n'
    put(path, head, methods, '}\n')

C = 'App\\Http\\Controllers'
controller(A + 'app/Http/Controllers/OrderController.php', C,
           ['App\\Http\\Requests\\PlaceOrderRequest', 'App\\Http\\Resources\\OrderResource', 'App\\Models\\Order', 'App\\Services\\Cart\\CartService', 'App\\Services\\Checkout\\CheckoutService', 'Illuminate\\Http\\Request'],
           'OrderController', '        private CheckoutService $checkout,\n        private CartService $carts,',
           ['''
    public function store(PlaceOrderRequest $request): OrderResource
    {
        $cart = $this->carts->current($request->cookie('cart'), $request->user()?->customer?->id);
        $order = $this->checkout->placeOrder($cart, $request->validated());

        return new OrderResource($order->load('items'));
    }
''', '''
    public function index(Request $request)
    {
        return OrderResource::collection($request->user()->customer->orders()->latest('placed_at')->paginate(20));
    }
''', '''
    public function show(Request $request, string $number): OrderResource
    {
        $order = Order::where('number', $number)->where('customer_id', $request->user()->customer->id)->firstOrFail();
        return new OrderResource($order->load(['items', 'shipments']));
    }
'''])
controller(A + 'app/Http/Controllers/CheckoutController.php', C,
           ['App\\Services\\Cart\\CartService', 'App\\Services\\Checkout\\CheckoutService', 'App\\Services\\Shipping\\ShippingQuotes', 'Illuminate\\Http\\Request'],
           'CheckoutController', '        private CheckoutService $checkout,\n        private CartService $carts,\n        private ShippingQuotes $shipping,',
           ['''
    public function quote(Request $request): array
    {
        $cart = $this->carts->current($request->cookie('cart'));
        return $this->checkout->quote($cart, $request->string('shipping_method', 'standard'));
    }
''', '''
    public function shippingOptions(Request $request): array
    {
        return $this->shipping->options($this->carts->current($request->cookie('cart')));
    }
'''])
controller(A + 'app/Http/Controllers/CartController.php', C,
           ['App\\Http\\Requests\\AddCartItemRequest', 'App\\Http\\Resources\\CartResource', 'App\\Services\\Cart\\CartService', 'Illuminate\\Http\\Request'],
           'CartController', '        private CartService $carts,',
           ['''
    public function show(Request $request): CartResource
    {
        return new CartResource($this->carts->current($request->cookie('cart'))->load('items.variant.product'));
    }
''', '''
    public function add(AddCartItemRequest $request): CartResource
    {
        $cart = $this->carts->current($request->cookie('cart'));
        $this->carts->add($cart, $request->integer('variant_id'), $request->integer('quantity'));
        return new CartResource($cart->refresh());
    }
''', '''
    public function remove(Request $request, int $item): CartResource
    {
        $cart = $this->carts->current($request->cookie('cart'));
        $this->carts->remove($cart, $item);
        return new CartResource($cart->refresh());
    }
'''])
controller(A + 'app/Http/Controllers/ProductController.php', C,
           ['App\\Http\\Resources\\ProductResource', 'App\\Services\\Catalog\\CatalogService', 'Illuminate\\Http\\Request'],
           'ProductController', '        private CatalogService $catalog,',
           ['''
    public function index(Request $request)
    {
        return ProductResource::collection($this->catalog->browse($request->query('category'), $request->query('sort', 'popular')));
    }
''', '''
    public function show(string $slug): ProductResource
    {
        return new ProductResource($this->catalog->bySlug($slug));
    }
'''])
controller(A + 'app/Http/Controllers/CategoryController.php', C, ['App\\Http\\Resources\\CategoryResource', 'App\\Models\\Category'], 'CategoryController', '',
           ['''
    public function index()
    {
        return CategoryResource::collection(Category::whereNull('parent_id')->orderBy('position')->get());
    }
'''])
controller(A + 'app/Http/Controllers/ReviewController.php', C,
           ['App\\Http\\Requests\\StoreReviewRequest', 'App\\Http\\Resources\\ReviewResource', 'App\\Models\\Product', 'App\\Models\\Review', 'App\\Events\\ReviewSubmitted', 'Illuminate\\Http\\Request'],
           'ReviewController', '',
           ['''
    public function index(string $slug)
    {
        $product = Product::where('slug', $slug)->firstOrFail();
        return ReviewResource::collection($product->reviews()->published()->latest()->paginate(10));
    }
''', '''
    public function store(StoreReviewRequest $request, string $slug): ReviewResource
    {
        $product = Product::where('slug', $slug)->firstOrFail();
        $review = Review::create([...$request->validated(), 'product_id' => $product->id, 'customer_id' => $request->user()->customer->id, 'status' => 'pending']);
        ReviewSubmitted::dispatch($review);
        return new ReviewResource($review);
    }
'''])
controller(A + 'app/Http/Controllers/SearchController.php', C, ['App\\Http\\Resources\\ProductResource', 'App\\Services\\Search\\SearchIndex', 'Illuminate\\Http\\Request'], 'SearchController',
           '        private SearchIndex $index,',
           ['''
    public function __invoke(Request $request)
    {
        return ProductResource::collection($this->index->search($request->string('q')));
    }
'''])
controller(A + 'app/Http/Controllers/WishlistController.php', C, ['App\\Models\\WishlistItem', 'Illuminate\\Http\\Request'], 'WishlistController', '',
           ['''
    public function index(Request $request)
    {
        return WishlistItem::with('product')->where('customer_id', $request->user()->customer->id)->get();
    }
''', '''
    public function toggle(Request $request, int $product): array
    {
        $customer = $request->user()->customer->id;
        $item = WishlistItem::where(['customer_id' => $customer, 'product_id' => $product])->first();
        $item ? $item->delete() : WishlistItem::create(['customer_id' => $customer, 'product_id' => $product]);
        return ['saved' => ! $item];
    }
'''])
controller(A + 'app/Http/Controllers/AccountController.php', C,
           ['App\\Http\\Requests\\RegisterRequest', 'App\\Http\\Requests\\StoreAddressRequest', 'App\\Http\\Resources\\CustomerResource', 'App\\Models\\Address', 'App\\Services\\Customers\\CustomerService', 'Illuminate\\Http\\Request'],
           'AccountController', '        private CustomerService $customers,',
           ['''
    public function register(RegisterRequest $request): CustomerResource
    {
        return new CustomerResource($this->customers->register($request->validated()));
    }
''', '''
    public function me(Request $request): CustomerResource
    {
        return new CustomerResource($request->user()->customer->load('addresses'));
    }
''', '''
    public function addAddress(StoreAddressRequest $request): Address
    {
        return Address::create([...$request->validated(), 'customer_id' => $request->user()->customer->id]);
    }
''', '''
    public function destroy(Request $request): array
    {
        $this->customers->forget($request->user()->customer);
        return ['deleted' => true];
    }
'''])
controller(A + 'app/Http/Controllers/PaymentWebhookController.php', C, ['App\\Services\\Payments\\PaymentGateway', 'Illuminate\\Http\\Request'], 'PaymentWebhookController',
           '        private PaymentGateway $payments,',
           ['''
    public function __invoke(Request $request): array
    {
        $this->payments->handleWebhook($request->json()->all());
        return ['received' => true];
    }
'''])
AC = 'App\\Http\\Controllers\\Admin'
def admin_controller(name, uses, ctor, methods):
    controller(f'{A}app/Http/Controllers/Admin/{name}.php', AC, uses + ['App\\Http\\Controllers\\Controller'], name, ctor, methods)
admin_controller('ProductAdminController', ['App\\Http\\Requests\\UpdateProductRequest', 'App\\Http\\Resources\\ProductResource', 'App\\Models\\Product', 'App\\Services\\Search\\SearchIndex'],
                 '        private SearchIndex $search,',
                 ['''
    public function index()
    {
        return ProductResource::collection(Product::with('variants')->latest()->paginate(50));
    }
''', '''
    public function update(UpdateProductRequest $request, Product $product): ProductResource
    {
        $product->update($request->validated());
        $this->search->index($product);
        return new ProductResource($product);
    }
'''])
admin_controller('OrderAdminController', ['App\\Http\\Resources\\OrderResource', 'App\\Models\\Order', 'App\\Services\\Shipping\\LabelPrinter', 'App\\Events\\OrderShipped'],
                 '        private LabelPrinter $labels,',
                 ['''
    public function index()
    {
        return OrderResource::collection(Order::with('customer.user')->latest('placed_at')->paginate(50));
    }
''', '''
    public function ship(Order $order): OrderResource
    {
        $shipment = $this->labels->printFor($order);
        $order->update(['status' => 'shipped']);
        OrderShipped::dispatch($order, $shipment);
        return new OrderResource($order);
    }
'''])
admin_controller('RefundController', ['App\\Http\\Requests\\RefundRequest', 'App\\Models\\Order', 'App\\Services\\Payments\\RefundService'],
                 '        private RefundService $refunds,',
                 ['''
    public function store(RefundRequest $request, Order $order): array
    {
        abort_if($request->integer('amount_cents') > $this->refunds->refundable($order), 422, 'More than the order has left to refund');
        $refund = $this->refunds->refund($order, $request->integer('amount_cents'), $request->string('reason'));
        return ['refund' => $refund->id, 'status' => $refund->status];
    }
'''])
admin_controller('ReportController', ['App\\Services\\Reports\\SalesReport', 'Carbon\\CarbonImmutable', 'Illuminate\\Http\\Request'],
                 '        private SalesReport $sales,',
                 ['''
    public function sales(Request $request): array
    {
        $to = CarbonImmutable::parse($request->query('to', 'today'));
        return $this->sales->range($to->subDays((int) $request->query('days', 30)), $to);
    }
'''])
put(A + 'app/Http/Middleware/AdminOnly.php', '', ['''<?php

namespace App\\Http\\Middleware;

use Closure;
use Illuminate\\Http\\Request;

class AdminOnly
{
    public function handle(Request $request, Closure $next)
    {
        abort_unless($request->user()?->is_admin, 403);
        return $next($request);
    }
}
'''])

put(A + 'routes/api.php', '''<?php

use App\\Http\\Controllers\\AccountController;
use App\\Http\\Controllers\\Admin\\OrderAdminController;
use App\\Http\\Controllers\\Admin\\ProductAdminController;
use App\\Http\\Controllers\\Admin\\RefundController;
use App\\Http\\Controllers\\Admin\\ReportController;
use App\\Http\\Controllers\\CartController;
use App\\Http\\Controllers\\CategoryController;
use App\\Http\\Controllers\\CheckoutController;
use App\\Http\\Controllers\\OrderController;
use App\\Http\\Controllers\\PaymentWebhookController;
use App\\Http\\Controllers\\ProductController;
use App\\Http\\Controllers\\ReviewController;
use App\\Http\\Controllers\\SearchController;
use App\\Http\\Controllers\\WishlistController;
use App\\Http\\Middleware\\AdminOnly;
use Illuminate\\Support\\Facades\\Route;
''', ['''
Route::get('products', [ProductController::class, 'index']);
Route::get('products/{slug}', [ProductController::class, 'show']);
Route::get('categories', [CategoryController::class, 'index']);
''', '''
Route::get('cart', [CartController::class, 'show']);
Route::post('cart/items', [CartController::class, 'add']);
Route::delete('cart/items/{item}', [CartController::class, 'remove']);
''', '''
Route::post('checkout/quote', [CheckoutController::class, 'quote']);
Route::get('checkout/shipping', [CheckoutController::class, 'shippingOptions']);
Route::post('orders', [OrderController::class, 'store']);
Route::post('webhooks/stripe', PaymentWebhookController::class);
''', '''
Route::get('search', SearchController::class);
Route::get('products/{slug}/reviews', [ReviewController::class, 'index']);
''', '''
Route::post('account/register', [AccountController::class, 'register']);

Route::middleware('auth:sanctum')->group(function () {
    Route::get('account', [AccountController::class, 'me']);
    Route::post('account/addresses', [AccountController::class, 'addAddress']);
    Route::delete('account', [AccountController::class, 'destroy']);
    Route::get('orders', [OrderController::class, 'index']);
    Route::get('orders/{number}', [OrderController::class, 'show']);
    Route::post('products/{slug}/reviews', [ReviewController::class, 'store']);
    Route::get('wishlist', [WishlistController::class, 'index']);
    Route::post('wishlist/{product}', [WishlistController::class, 'toggle']);
});
''', '''
Route::middleware(['auth:sanctum', AdminOnly::class])->prefix('admin')->group(function () {
    Route::get('products', [ProductAdminController::class, 'index']);
    Route::patch('products/{product}', [ProductAdminController::class, 'update']);
    Route::get('orders', [OrderAdminController::class, 'index']);
    Route::post('orders/{order}/ship', [OrderAdminController::class, 'ship']);
    Route::post('orders/{order}/refunds', [RefundController::class, 'store']);
    Route::get('reports/sales', [ReportController::class, 'sales']);
});
'''])

# Events, listeners, jobs, mail, policies, commands --------------------------------------------------------------------
EVENTS = {'OrderPlaced': ['Order $order'], 'OrderShipped': ['Order $order', 'Shipment $shipment'], 'PaymentCaptured': ['Payment $payment'], 'ReviewSubmitted': ['Review $review']}
for name, props in EVENTS.items():
    models = [p.split()[0] for p in props]
    put(f'{A}app/Events/{name}.php', '', [f'''<?php

namespace App\\Events;

{use_models(models)}use Illuminate\\Foundation\\Events\\Dispatchable;
use Illuminate\\Queue\\SerializesModels;

class {name}
{{
    use Dispatchable, SerializesModels;

    public function __construct({", ".join("public " + p for p in props)}) {{}}
}}
'''])
def listener(name, event, uses, ctor, body):
    put(f'{A}app/Listeners/{name}.php', '', [f'''<?php

namespace App\\Listeners;

use App\\Events\\{event};
{use_lines(uses)}use Illuminate\\Contracts\\Queue\\ShouldQueue;

class {name} implements ShouldQueue
{{
{ctor}
    public function handle({event} $event): void
    {{
{body}
    }}
}}
'''])
listener('SendOrderConfirmation', 'OrderPlaced', ['App\\Mail\\OrderConfirmation', 'Illuminate\\Support\\Facades\\Mail'], '', '        Mail::to($event->order->customer->user->email)->send(new OrderConfirmation($event->order));')
listener('CapturePaymentLater', 'OrderPlaced', ['App\\Jobs\\CapturePayment'], '', '        CapturePayment::dispatch($event->order)->delay(now()->addMinutes(30));')
listener('SendShippingUpdate', 'OrderShipped', ['App\\Mail\\ShippingUpdate', 'Illuminate\\Support\\Facades\\Mail'], '', '        Mail::to($event->order->customer->user->email)->send(new ShippingUpdate($event->order, $event->shipment));')
listener('ModerateReview', 'ReviewSubmitted', ['App\\Services\\Reviews\\ReviewModeration'], '    public function __construct(private ReviewModeration $moderation) {}\n', '        $this->moderation->moderate($event->review);')
def job(name, uses, ctor_params, body, handle_params=''):
    put(f'{A}app/Jobs/{name}.php', '', [f'''<?php

namespace App\\Jobs;

{use_lines(uses)}use Illuminate\\Bus\\Queueable;
use Illuminate\\Contracts\\Queue\\ShouldQueue;
use Illuminate\\Foundation\\Bus\\Dispatchable;

class {name} implements ShouldQueue
{{
    use Dispatchable, Queueable;

    public function __construct({ctor_params}) {{}}

    public function handle({handle_params}): void
    {{
{body}
    }}
}}
'''])
job('CapturePayment', ['App\\Models\\Order', 'App\\Services\\Payments\\PaymentGateway'], 'public Order $order', '        $payment = $this->order->payments()->where(\'status\', \'requires_capture\')->first();\n        if ($payment) {\n            $payments->capture($payment);\n        }', 'PaymentGateway $payments')
job('SyncInventory', ['App\\Services\\Inventory\\StockSync'], 'public string $warehouse = \'main\'', '        $sync->pull($this->warehouse);', 'StockSync $sync')
job('RebuildSearchIndex', ['App\\Services\\Search\\SearchIndex'], '', '        $index->rebuild();', 'SearchIndex $index')
job('SendAbandonedCartEmails', ['App\\Mail\\AbandonedCart', 'App\\Models\\Cart', 'Illuminate\\Support\\Facades\\Mail'], '', '        Cart::with(\'customer.user\')->whereNotNull(\'customer_id\')->where(\'updated_at\', \'<\', now()->subDay())->each(\n            fn (Cart $cart) => Mail::to($cart->customer->user->email)->send(new AbandonedCart($cart))\n        );')
def mail(name, props, subject):
    models = [p.split()[0] for p in props]
    put(f'{A}app/Mail/{name}.php', '', [f'''<?php

namespace App\\Mail;

{use_models(models)}use Illuminate\\Mail\\Mailable;
use Illuminate\\Mail\\Mailables\\Content;
use Illuminate\\Mail\\Mailables\\Envelope;

class {name} extends Mailable
{{
    public function __construct({", ".join("public " + p for p in props)}) {{}}

    public function envelope(): Envelope
    {{
        return new Envelope(subject: {subject});
    }}

    public function content(): Content
    {{
        return new Content(markdown: 'mail.{snake(name).replace("_", "-")}');
    }}
}}
'''])
mail('OrderConfirmation', ['Order $order'], "'Your order ' . $this->order->number")
mail('ShippingUpdate', ['Order $order', 'Shipment $shipment'], "'Your order is on its way'")
mail('AbandonedCart', ['Cart $cart'], "'You left something in your cart'")
def policy(name, model, body):
    put(f'{A}app/Policies/{name}.php', '', [f'''<?php

namespace App\\Policies;

use App\\Models\\{model};
use App\\Models\\User;

class {name}
{{
{body}
}}
'''])
policy('OrderPolicy', 'Order', '    public function view(User $user, Order $order): bool\n    {\n        return $user->is_admin || $order->customer_id === $user->customer?->id;\n    }')
policy('ReviewPolicy', 'Review', '    public function delete(User $user, Review $review): bool\n    {\n        return $user->is_admin || $review->customer_id === $user->customer?->id;\n    }')
def command(name, signature, uses, handle_params, body):
    put(f'{A}app/Console/Commands/{name}.php', '', [f'''<?php

namespace App\\Console\\Commands;

{use_lines(uses)}use Illuminate\\Console\\Command;

class {name} extends Command
{{
    protected $signature = '{signature}';

    public function handle({handle_params}): int
    {{
{body}
        return self::SUCCESS;
    }}
}}
'''])
command('ImportProducts', 'products:import {file}', ['App\\Services\\Catalog\\ProductImporter'], 'ProductImporter $importer', "        $this->info($importer->import($this->argument('file')) . ' products imported');")
command('PruneCarts', 'carts:prune', ['App\\Models\\Cart'], '', "        $this->info(Cart::where('expires_at', '<', now())->delete() . ' carts pruned');")
command('ReconcilePayments', 'payments:reconcile', ['App\\Models\\Payment', 'App\\Services\\Payments\\PaymentGateway'], 'PaymentGateway $payments', "        Payment::where('status', 'requires_capture')->where('created_at', '<', now()->subDays(6))->each(fn (Payment $payment) => $payments->capture($payment));")
put(A + 'routes/console.php', '', ['''<?php

use App\\Jobs\\RebuildSearchIndex;
use App\\Jobs\\SendAbandonedCartEmails;
use App\\Jobs\\SyncInventory;
use Illuminate\\Support\\Facades\\Schedule;

Schedule::job(new SyncInventory)->everyFifteenMinutes();
Schedule::job(new SendAbandonedCartEmails)->dailyAt('10:00');
Schedule::job(new RebuildSearchIndex)->weekly();
Schedule::command('carts:prune')->daily();
Schedule::command('payments:reconcile')->hourly();
'''])
put(A + 'app/Providers/AppServiceProvider.php', '', ['''<?php

namespace App\\Providers;

use App\\Models\\Order;
use App\\Models\\Review;
use App\\Policies\\OrderPolicy;
use App\\Policies\\ReviewPolicy;
use Illuminate\\Support\\Facades\\Gate;
use Illuminate\\Support\\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Gate::policy(Order::class, OrderPolicy::class);
        Gate::policy(Review::class, ReviewPolicy::class);
    }
}
'''])
for name, body in {
    'app': "'name' => env('APP_NAME', 'Storefront'), 'env' => env('APP_ENV', 'production'), 'url' => env('APP_URL', 'http://localhost')",
    'database': "'default' => env('DB_CONNECTION', 'pgsql'), 'connections' => ['pgsql' => ['driver' => 'pgsql', 'url' => env('DATABASE_URL')]]",
    'services': "'stripe' => ['secret' => env('STRIPE_SECRET')], 'dhl' => ['key' => env('DHL_KEY'), 'url' => env('DHL_URL')]",
    'shop': "'free_shipping_cents' => 7500, 'search' => ['url' => env('SEARCH_URL')], 'warehouses' => ['main' => ['url' => env('WAREHOUSE_URL')]]",
}.items():
    put(f'{A}config/{name}.php', '', [f'<?php\n\nreturn [{body}];\n'])
for name, model, fields in [('ProductFactory', 'Product', "'name' => fake()->words(3, true), 'slug' => fake()->slug(), 'price_cents' => fake()->numberBetween(500, 20000), 'currency' => 'EUR', 'active' => true"),
                            ('OrderFactory', 'Order', "'number' => fake()->unique()->bothify('SF-######'), 'status' => 'pending', 'total_cents' => fake()->numberBetween(1000, 50000), 'currency' => 'EUR'"),
                            ('UserFactory', 'User', "'name' => fake()->name(), 'email' => fake()->unique()->safeEmail(), 'password' => bcrypt('password')")]:
    put(f'{A}database/factories/{name}.php', '', [f'''<?php

namespace Database\\Factories;

use Illuminate\\Database\\Eloquent\\Factories\\Factory;

class {name} extends Factory
{{
    public function definition(): array
    {{
        return [{fields}];
    }}
}}
'''])
put(A + 'database/seeders/DatabaseSeeder.php', '', ['''<?php

namespace Database\\Seeders;

use App\\Models\\Product;
use App\\Models\\User;
use Illuminate\\Database\\Seeder;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        User::factory()->create(['email' => 'admin@storefront.dev', 'is_admin' => true]);
        Product::factory(48)->create();
    }
}
'''])
TESTS = {
    'Feature/CheckoutTest': ['places_an_order_from_the_cart', 'charges_the_order_total', 'refuses_an_out_of_stock_cart', 'gives_free_shipping_over_the_threshold'],
    'Feature/CartTest': ['adds_an_item', 'merges_the_same_variant', 'removes_an_item'],
    'Feature/ProductTest': ['lists_active_products', 'filters_by_category', 'shows_a_product_by_slug'],
    'Feature/ReviewTest': ['holds_a_review_with_links', 'publishes_a_clean_review'],
    'Feature/RefundTest': ['refunds_part_of_an_order', 'refuses_more_than_the_total'],
    'Feature/AccountTest': ['registers_a_customer', 'forgets_a_customer'],
    'Unit/PricingServiceTest': ['discounts_ten_or_more', 'adds_tax_and_shipping'],
    'Unit/TaxCalculatorTest': ['uses_the_regional_rate', 'falls_back_to_the_country_rate'],
}
for name, cases in TESTS.items():
    cls = name.split('/')[1]
    put(f'{A}tests/{name}.php', f'''<?php

namespace Tests\\{name.split("/")[0]};

use Illuminate\\Foundation\\Testing\\RefreshDatabase;
use Tests\\TestCase;

class {cls} extends TestCase
{{
    use RefreshDatabase;
''', [f'''
    public function test_{case}(): void
    {{
        $this->markTestIncomplete('{case.replace("_", " ")}');
    }}
''' for case in cases], '}\n')
put(A + 'tests/TestCase.php', '', ['''<?php

namespace Tests;

use Illuminate\\Foundation\\Testing\\TestCase as BaseTestCase;

abstract class TestCase extends BaseTestCase
{
}
'''])

# ---------------------------------------------------------------------------------------------------------------- WEB
W = 'web/'
put(W + 'package.json', '', ['''{
  "name": "storefront-web",
  "private": true,
  "scripts": { "dev": "next dev", "build": "next build", "start": "next start" },
  "dependencies": { "next": "16.0.7", "react": "19.2.0", "react-dom": "19.2.0" },
  "devDependencies": { "typescript": "5.9.3", "@types/react": "19.2.2" }
}
'''])
put(W + 'tsconfig.json', '', ['''{
  "compilerOptions": {
    "target": "ES2022", "lib": ["dom", "dom.iterable", "esnext"], "module": "esnext", "moduleResolution": "bundler",
    "jsx": "preserve", "strict": true, "noEmit": true, "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
'''])
put(W + 'next.config.ts', '', ['''import type { NextConfig } from 'next';

const config: NextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.API_URL ?? 'http://localhost:8000'}/api/:path*` }];
  },
};

export default config;
'''])
put(W + 'src/lib/api/client.ts', '', ['''\'use client\';
// Every call to the Laravel API goes through here: JSON in and out, the cart cookie sent along.
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', accept: 'application/json', ...init.headers } });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  return response.json() as Promise<T>;
}
'''])
put(W + 'src/lib/types.ts', '', ['''export interface Variant { id: number; sku: string; name: string; price_cents: number }
export interface Product { id: number; name: string; slug: string; price_cents: number; variants?: Variant[] }
export interface CartLine { id: number; quantity: number; unit_price_cents: number; variant: Variant & { product: Product } }
export interface Cart { token: string; items: CartLine[]; subtotal_cents: number }
export interface Order { number: string; status: string; total_cents: number; currency: string }
export interface Quote { subtotal: number; tax: number; shipping: number; total: number }
export interface Review { rating: number; title: string; body: string; author?: string }
'''])
put(W + 'src/lib/api/orders.ts', "'use client';\nimport { apiFetch } from './client';\nimport type { Order, Quote } from '../types';\n", ['''
export interface OrderDetails { shipping_method: 'standard' | 'express' | 'pickup'; payment_method: string }

/** Places the order for the current cart: the API prices it, reserves the stock and charges the card. */
export function placeOrder(details: OrderDetails): Promise<{ data: Order }> {
  return apiFetch('/api/orders', { method: 'POST', body: JSON.stringify(details) });
}
''', '''
export function listOrders(): Promise<{ data: Order[] }> {
  return apiFetch('/api/orders');
}

export function getOrder(number: string): Promise<{ data: Order }> {
  return apiFetch(`/api/orders/${number}`);
}
''', '''
export function quote(shippingMethod: string): Promise<Quote> {
  return apiFetch('/api/checkout/quote', { method: 'POST', body: JSON.stringify({ shipping_method: shippingMethod }) });
}
'''])
put(W + 'src/lib/api/cart.ts', "'use client';\nimport { apiFetch } from './client';\nimport type { Cart } from '../types';\n", ['''
export function getCart(): Promise<{ data: Cart }> {
  return apiFetch('/api/cart');
}
''', '''
export function addToCart(variantId: number, quantity = 1): Promise<{ data: Cart }> {
  return apiFetch('/api/cart/items', { method: 'POST', body: JSON.stringify({ variant_id: variantId, quantity }) });
}
''', '''
export function removeFromCart(itemId: number): Promise<{ data: Cart }> {
  return apiFetch(`/api/cart/items/${itemId}`, { method: 'DELETE' });
}
'''])
put(W + 'src/lib/api/products.ts', "'use client';\nimport { apiFetch } from './client';\nimport type { Product } from '../types';\n", ['''
export function listProducts(category?: string, sort = 'popular'): Promise<{ data: Product[] }> {
  return apiFetch(`/api/products?sort=${sort}${category ? `&category=${category}` : ''}`);
}
''', '''
export function getProduct(slug: string): Promise<{ data: Product }> {
  return apiFetch(`/api/products/${slug}`);
}
''', '''
export function listCategories(): Promise<{ data: { name: string; slug: string }[] }> {
  return apiFetch('/api/categories');
}
'''])
put(W + 'src/lib/api/reviews.ts', "'use client';\nimport { apiFetch } from './client';\nimport type { Review } from '../types';\n", ['''
export function listReviews(slug: string): Promise<{ data: Review[] }> {
  return apiFetch(`/api/products/${slug}/reviews`);
}
''', '''
export function submitReview(slug: string, review: Omit<Review, 'author'>): Promise<{ data: Review }> {
  return apiFetch(`/api/products/${slug}/reviews`, { method: 'POST', body: JSON.stringify(review) });
}
'''])
put(W + 'src/lib/api/search.ts', "'use client';\nimport { apiFetch } from './client';\nimport type { Product } from '../types';\n", ['''
export function searchProducts(query: string): Promise<{ data: Product[] }> {
  return apiFetch(`/api/search?q=${encodeURIComponent(query)}`);
}
'''])
put(W + 'src/lib/api/account.ts', "'use client';\nimport { apiFetch } from './client';\n", ['''
export function register(name: string, email: string, password: string) {
  return apiFetch('/api/account/register', { method: 'POST', body: JSON.stringify({ name, email, password }) });
}
''', '''
export function me() {
  return apiFetch<{ data: { name: string; email: string } }>('/api/account');
}
''', '''
export function addAddress(address: { line1: string; city: string; postcode: string; country: string }) {
  return apiFetch('/api/account/addresses', { method: 'POST', body: JSON.stringify(address) });
}
'''])
put(W + 'src/lib/api/shipping.ts', "'use client';\nimport { apiFetch } from './client';\n", ['''
export interface ShippingOption { method: 'standard' | 'express' | 'pickup'; price_cents: number }

export function shippingOptions(): Promise<ShippingOption[]> {
  return apiFetch('/api/checkout/shipping');
}
'''])
put(W + 'src/lib/api/wishlist.ts', "'use client';\nimport { apiFetch } from './client';\n", ['''
export function toggleWishlist(productId: number): Promise<{ saved: boolean }> {
  return apiFetch(`/api/wishlist/${productId}`, { method: 'POST' });
}
'''])
put(W + 'src/lib/api/admin.ts', "'use client';\nimport { apiFetch } from './client';\nimport type { Order, Product } from '../types';\n", ['''
export function adminProducts(): Promise<{ data: Product[] }> {
  return apiFetch('/api/admin/products');
}
''', '''
export function adminOrders(): Promise<{ data: Order[] }> {
  return apiFetch('/api/admin/orders');
}

export function shipOrder(id: number): Promise<{ data: Order }> {
  return apiFetch(`/api/admin/orders/${id}/ship`, { method: 'POST' });
}
''', '''
export function refundOrder(id: number, amountCents: number, reason: string) {
  return apiFetch(`/api/admin/orders/${id}/refunds`, { method: 'POST', body: JSON.stringify({ amount_cents: amountCents, reason }) });
}

export function salesReport(days = 30): Promise<{ day: string; orders: number; revenue_cents: number }[]> {
  return apiFetch(`/api/admin/reports/sales?days=${days}`);
}
'''])
put(W + 'src/lib/money.ts', '', ['''export function formatMoney(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}
''', '''
export function sumCents(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
'''])
put(W + 'src/hooks/useCart.ts', "'use client';\nimport { useCallback, useEffect, useState } from 'react';\nimport { addToCart, getCart, removeFromCart } from '../lib/api/cart';\nimport type { Cart } from '../lib/types';\n", ['''
export function useCart() {
  const [cart, setCart] = useState<Cart | undefined>();
  useEffect(() => { void getCart().then(result => setCart(result.data)); }, []);
  const add = useCallback(async (variantId: number, quantity = 1) => setCart((await addToCart(variantId, quantity)).data), []);
  const remove = useCallback(async (itemId: number) => setCart((await removeFromCart(itemId)).data), []);
  return { cart, add, remove };
}
'''])

def component(path, imports, parts):
    put(W + path, "'use client';\n" + imports, parts)
component('src/components/checkout/PlaceOrderButton.tsx', "import { useState } from 'react';\nimport { placeOrder, type OrderDetails } from '../../lib/api/orders';\n", ['''
export function PlaceOrderButton({ details, onPlaced }: { details: OrderDetails; onPlaced: (number: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const { data } = await placeOrder(details);
      onPlaced(data.number);
    } finally {
      setBusy(false);
    }
  }
  return <button className="button primary" onClick={submit} disabled={busy}>{busy ? 'Placing…' : 'Place order'}</button>;
}
'''])
component('src/components/checkout/CheckoutForm.tsx', "import { useState } from 'react';\nimport { useRouter } from 'next/navigation';\nimport { PlaceOrderButton } from './PlaceOrderButton';\nimport { ShippingOptions } from './ShippingOptions';\nimport { PaymentFields } from './PaymentFields';\n", ['''
export function CheckoutForm() {
  const router = useRouter();
  const [shipping, setShipping] = useState<'standard' | 'express' | 'pickup'>('standard');
  const [paymentMethod, setPaymentMethod] = useState('');
  return (
    <form className="checkout-form" onSubmit={event => event.preventDefault()}>
      <ShippingOptions value={shipping} onChange={setShipping} />
      <PaymentFields onReady={setPaymentMethod} />
      <PlaceOrderButton details={{ shipping_method: shipping, payment_method: paymentMethod }} onPlaced={number => router.push(`/checkout/success?order=${number}`)} />
    </form>
  );
}
'''])
component('src/components/checkout/ShippingOptions.tsx', "import { useEffect, useState } from 'react';\nimport { shippingOptions, type ShippingOption } from '../../lib/api/shipping';\nimport { formatMoney } from '../../lib/money';\n", ['''
export function ShippingOptions({ value, onChange }: { value: ShippingOption['method']; onChange: (method: ShippingOption['method']) => void }) {
  const [options, setOptions] = useState<ShippingOption[]>([]);
  useEffect(() => { void shippingOptions().then(setOptions); }, []);
  return (
    <fieldset className="shipping-options">
      <legend>Delivery</legend>
      {options.map(option => (
        <label key={option.method}>
          <input type="radio" checked={value === option.method} onChange={() => onChange(option.method)} /> {option.method} · {option.price_cents ? formatMoney(option.price_cents) : 'Free'}
        </label>
      ))}
    </fieldset>
  );
}
'''])
component('src/components/checkout/PaymentFields.tsx', "import { useEffect } from 'react';\n", ['''
export function PaymentFields({ onReady }: { onReady: (paymentMethod: string) => void }) {
  useEffect(() => { onReady('pm_card_visa'); }, [onReady]);
  return <div className="payment-fields" data-provider="stripe" />;
}
'''])
component('src/components/checkout/OrderSummary.tsx', "import { useEffect, useState } from 'react';\nimport { quote } from '../../lib/api/orders';\nimport { formatMoney } from '../../lib/money';\nimport type { Quote } from '../../lib/types';\n", ['''
export function OrderSummary({ shipping }: { shipping: string }) {
  const [totals, setTotals] = useState<Quote | undefined>();
  useEffect(() => { void quote(shipping).then(setTotals); }, [shipping]);
  if (!totals) return null;
  return (
    <dl className="order-summary">
      <dt>Subtotal</dt><dd>{formatMoney(totals.subtotal)}</dd>
      <dt>Shipping</dt><dd>{formatMoney(totals.shipping)}</dd>
      <dt>Tax</dt><dd>{formatMoney(totals.tax)}</dd>
      <dt>Total</dt><dd>{formatMoney(totals.total)}</dd>
    </dl>
  );
}
'''])
component('src/components/cart/CartLineItem.tsx', "import { formatMoney } from '../../lib/money';\nimport type { CartLine } from '../../lib/types';\n", ['''
export function CartLineItem({ line, onRemove }: { line: CartLine; onRemove: () => void }) {
  return (
    <li className="cart-line">
      <span>{line.variant.product.name} · {line.variant.name}</span>
      <span>{line.quantity} × {formatMoney(line.unit_price_cents)}</span>
      <button className="link" onClick={onRemove}>Remove</button>
    </li>
  );
}
'''])
component('src/components/cart/CartSummary.tsx', "import Link from 'next/link';\nimport { formatMoney } from '../../lib/money';\nimport type { Cart } from '../../lib/types';\n", ['''
export function CartSummary({ cart }: { cart: Cart }) {
  return (
    <aside className="cart-summary">
      <p>Subtotal <strong>{formatMoney(cart.subtotal_cents)}</strong></p>
      <Link className="button primary" href="/checkout">Checkout</Link>
    </aside>
  );
}
'''])
component('src/components/product/ProductCard.tsx', "import Link from 'next/link';\nimport { PriceTag } from './PriceTag';\nimport type { Product } from '../../lib/types';\n", ['''
export function ProductCard({ product }: { product: Product }) {
  return (
    <Link className="product-card" href={`/products/${product.slug}`}>
      <span className="name">{product.name}</span>
      <PriceTag cents={product.price_cents} />
    </Link>
  );
}
'''])
component('src/components/product/ProductGrid.tsx', "import { ProductCard } from './ProductCard';\nimport type { Product } from '../../lib/types';\n", ['''
export function ProductGrid({ products }: { products: Product[] }) {
  return <div className="product-grid">{products.map(product => <ProductCard key={product.id} product={product} />)}</div>;
}
'''])
component('src/components/product/PriceTag.tsx', "import { formatMoney } from '../../lib/money';\n", ['''
export function PriceTag({ cents, currency = 'EUR' }: { cents: number; currency?: string }) {
  return <span className="price">{formatMoney(cents, currency)}</span>;
}
'''])
component('src/components/product/AddToCartButton.tsx', "import { useCart } from '../../hooks/useCart';\n", ['''
export function AddToCartButton({ variantId }: { variantId: number }) {
  const { add } = useCart();
  return <button className="button primary" onClick={() => void add(variantId)}>Add to cart</button>;
}
'''])
component('src/components/product/VariantPicker.tsx', "import type { Variant } from '../../lib/types';\n", ['''
export function VariantPicker({ variants, value, onChange }: { variants: Variant[]; value?: number; onChange: (id: number) => void }) {
  return (
    <div className="variant-picker">
      {variants.map(variant => <button key={variant.id} aria-pressed={variant.id === value} onClick={() => onChange(variant.id)}>{variant.name}</button>)}
    </div>
  );
}
'''])
component('src/components/product/WishlistButton.tsx', "import { useState } from 'react';\nimport { toggleWishlist } from '../../lib/api/wishlist';\n", ['''
export function WishlistButton({ productId }: { productId: number }) {
  const [saved, setSaved] = useState(false);
  return <button className="icon" aria-pressed={saved} onClick={async () => setSaved((await toggleWishlist(productId)).saved)}>{saved ? '♥' : '♡'}</button>;
}
'''])
component('src/components/reviews/ReviewList.tsx', "import { useEffect, useState } from 'react';\nimport { listReviews } from '../../lib/api/reviews';\nimport { StarRating } from './StarRating';\nimport type { Review } from '../../lib/types';\n", ['''
export function ReviewList({ slug }: { slug: string }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  useEffect(() => { void listReviews(slug).then(result => setReviews(result.data)); }, [slug]);
  return <ul className="reviews">{reviews.map((review, i) => <li key={i}><StarRating value={review.rating} /> <strong>{review.title}</strong><p>{review.body}</p></li>)}</ul>;
}
'''])
component('src/components/reviews/ReviewForm.tsx', "import { useState } from 'react';\nimport { submitReview } from '../../lib/api/reviews';\n", ['''
export function ReviewForm({ slug }: { slug: string }) {
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  return (
    <form className="review-form" onSubmit={event => { event.preventDefault(); void submitReview(slug, { rating, title, body }); }}>
      <input value={title} onChange={event => setTitle(event.target.value)} placeholder="Title" />
      <textarea value={body} onChange={event => setBody(event.target.value)} />
      <input type="number" min={1} max={5} value={rating} onChange={event => setRating(Number(event.target.value))} />
      <button className="button">Send review</button>
    </form>
  );
}
'''])
component('src/components/reviews/StarRating.tsx', '', ['''
export function StarRating({ value }: { value: number }) {
  return <span className="stars" aria-label={`${value} of 5`}>{'★'.repeat(value)}{'☆'.repeat(5 - value)}</span>;
}
'''])
component('src/components/layout/Header.tsx', "import Link from 'next/link';\nimport { SearchBar } from './SearchBar';\n", ['''
export function Header() {
  return (
    <header className="site-header">
      <Link href="/" className="logo">Storefront</Link>
      <SearchBar />
      <nav><Link href="/wishlist">Wishlist</Link> <Link href="/account">Account</Link> <Link href="/cart">Cart</Link></nav>
    </header>
  );
}
'''])
component('src/components/layout/SearchBar.tsx', "import { useRouter } from 'next/navigation';\nimport { useState } from 'react';\n", ['''
export function SearchBar() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  return <form onSubmit={event => { event.preventDefault(); router.push(`/search?q=${encodeURIComponent(query)}`); }}><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search" /></form>;
}
'''])
component('src/components/layout/Footer.tsx', '', ['''
export function Footer() {
  return <footer className="site-footer">© Storefront · Free returns within 30 days</footer>;
}
'''])
component('src/components/admin/OrderTable.tsx', "import { shipOrder } from '../../lib/api/admin';\nimport { formatMoney } from '../../lib/money';\nimport type { Order } from '../../lib/types';\n", ['''
export function OrderTable({ orders }: { orders: (Order & { id: number })[] }) {
  return (
    <table className="admin-table">
      <tbody>{orders.map(order => <tr key={order.number}><td>{order.number}</td><td>{order.status}</td><td>{formatMoney(order.total_cents)}</td><td><button onClick={() => void shipOrder(order.id)}>Ship</button></td></tr>)}</tbody>
    </table>
  );
}
'''])
component('src/components/admin/RefundDialog.tsx', "import { useState } from 'react';\nimport { refundOrder } from '../../lib/api/admin';\n", ['''
export function RefundDialog({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const [amount, setAmount] = useState(0);
  const [reason, setReason] = useState('');
  return (
    <dialog open className="refund-dialog">
      <input type="number" value={amount} onChange={event => setAmount(Number(event.target.value))} />
      <input value={reason} onChange={event => setReason(event.target.value)} placeholder="Reason" />
      <button onClick={async () => { await refundOrder(orderId, Math.round(amount * 100), reason); onDone(); }}>Refund</button>
    </dialog>
  );
}
'''])
component('src/components/admin/ProductTable.tsx', "import { formatMoney } from '../../lib/money';\nimport type { Product } from '../../lib/types';\n", ['''
export function ProductTable({ products }: { products: Product[] }) {
  return <table className="admin-table"><tbody>{products.map(product => <tr key={product.id}><td>{product.name}</td><td>{formatMoney(product.price_cents)}</td></tr>)}</tbody></table>;
}
'''])
component('src/components/admin/SalesChart.tsx', "import { formatMoney } from '../../lib/money';\n", ['''
export function SalesChart({ days }: { days: { day: string; revenue_cents: number }[] }) {
  const max = Math.max(1, ...days.map(day => day.revenue_cents));
  return <div className="sales-chart">{days.map(day => <span key={day.day} title={`${day.day}: ${formatMoney(day.revenue_cents)}`} style={{ height: `${(day.revenue_cents / max) * 100}%` }} />)}</div>;
}
'''])

def page(path, imports, body, client=True):
    put(W + 'src/app/' + path, ("'use client';\n" if client else '') + imports, [body])
page('layout.tsx', "import type { ReactNode } from 'react';\nimport { Header } from '../components/layout/Header';\nimport { Footer } from '../components/layout/Footer';\n", '''
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><Header /><main>{children}</main><Footer /></body></html>;
}
''', client=False)
page('page.tsx', "import { useEffect, useState } from 'react';\nimport { listProducts } from '../lib/api/products';\nimport { ProductGrid } from '../components/product/ProductGrid';\nimport type { Product } from '../lib/types';\n", '''
export default function HomePage() {
  const [products, setProducts] = useState<Product[]>([]);
  useEffect(() => { void listProducts(undefined, 'new').then(result => setProducts(result.data)); }, []);
  return <section><h1>New in</h1><ProductGrid products={products} /></section>;
}
''')
page('products/page.tsx', "import { useEffect, useState } from 'react';\nimport { listCategories, listProducts } from '../../lib/api/products';\nimport { ProductGrid } from '../../components/product/ProductGrid';\nimport type { Product } from '../../lib/types';\n", '''
export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<{ name: string; slug: string }[]>([]);
  const [category, setCategory] = useState<string | undefined>();
  useEffect(() => { void listCategories().then(result => setCategories(result.data)); }, []);
  useEffect(() => { void listProducts(category).then(result => setProducts(result.data)); }, [category]);
  return <section><nav>{categories.map(item => <button key={item.slug} onClick={() => setCategory(item.slug)}>{item.name}</button>)}</nav><ProductGrid products={products} /></section>;
}
''')
page('products/[slug]/page.tsx', "import { use, useEffect, useState } from 'react';\nimport { getProduct } from '../../../lib/api/products';\nimport { AddToCartButton } from '../../../components/product/AddToCartButton';\nimport { VariantPicker } from '../../../components/product/VariantPicker';\nimport { WishlistButton } from '../../../components/product/WishlistButton';\nimport { PriceTag } from '../../../components/product/PriceTag';\nimport { ReviewList } from '../../../components/reviews/ReviewList';\nimport type { Product } from '../../../lib/types';\n", '''
export default function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [product, setProduct] = useState<Product | undefined>();
  const [variant, setVariant] = useState<number | undefined>();
  useEffect(() => { void getProduct(slug).then(result => { setProduct(result.data); setVariant(result.data.variants?.[0]?.id); }); }, [slug]);
  if (!product) return null;
  return (
    <article className="product">
      <h1>{product.name} <WishlistButton productId={product.id} /></h1>
      <PriceTag cents={product.price_cents} />
      <VariantPicker variants={product.variants ?? []} value={variant} onChange={setVariant} />
      {variant && <AddToCartButton variantId={variant} />}
      <ReviewList slug={slug} />
    </article>
  );
}
''')
page('products/[slug]/review/page.tsx', "import { use } from 'react';\nimport { ReviewForm } from '../../../../components/reviews/ReviewForm';\n", '''
export default function WriteReviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  return <section><h1>Write a review</h1><ReviewForm slug={slug} /></section>;
}
''')
page('cart/page.tsx', "import { useCart } from '../../hooks/useCart';\nimport { CartLineItem } from '../../components/cart/CartLineItem';\nimport { CartSummary } from '../../components/cart/CartSummary';\n", '''
export default function CartPage() {
  const { cart, remove } = useCart();
  if (!cart) return null;
  return (
    <section className="cart">
      <ul>{cart.items.map(line => <CartLineItem key={line.id} line={line} onRemove={() => void remove(line.id)} />)}</ul>
      <CartSummary cart={cart} />
    </section>
  );
}
''')
page('checkout/page.tsx', "import { CheckoutForm } from '../../components/checkout/CheckoutForm';\nimport { OrderSummary } from '../../components/checkout/OrderSummary';\n", '''
export default function CheckoutPage() {
  return (
    <section className="checkout">
      <h1>Checkout</h1>
      <CheckoutForm />
      <OrderSummary shipping="standard" />
    </section>
  );
}
''')
page('checkout/success/page.tsx', "import { useSearchParams } from 'next/navigation';\n", '''
export default function OrderPlacedPage() {
  const order = useSearchParams().get('order');
  return <section><h1>Thank you!</h1><p>Your order {order} is confirmed. We sent you an email.</p></section>;
}
''')
page('orders/page.tsx', "import Link from 'next/link';\nimport { useEffect, useState } from 'react';\nimport { listOrders } from '../../lib/api/orders';\nimport { formatMoney } from '../../lib/money';\nimport type { Order } from '../../lib/types';\n", '''
export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  useEffect(() => { void listOrders().then(result => setOrders(result.data)); }, []);
  return <ul className="orders">{orders.map(order => <li key={order.number}><Link href={`/orders/${order.number}`}>{order.number}</Link> {order.status} {formatMoney(order.total_cents)}</li>)}</ul>;
}
''')
page('orders/[number]/page.tsx', "import { use, useEffect, useState } from 'react';\nimport { getOrder } from '../../../lib/api/orders';\nimport type { Order } from '../../../lib/types';\n", '''
export default function OrderPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = use(params);
  const [order, setOrder] = useState<Order | undefined>();
  useEffect(() => { void getOrder(number).then(result => setOrder(result.data)); }, [number]);
  return order ? <section><h1>Order {order.number}</h1><p>{order.status}</p></section> : null;
}
''')
page('search/page.tsx', "import { useSearchParams } from 'next/navigation';\nimport { useEffect, useState } from 'react';\nimport { searchProducts } from '../../lib/api/search';\nimport { ProductGrid } from '../../components/product/ProductGrid';\nimport type { Product } from '../../lib/types';\n", '''
export default function SearchPage() {
  const query = useSearchParams().get('q') ?? '';
  const [products, setProducts] = useState<Product[]>([]);
  useEffect(() => { if (query) void searchProducts(query).then(result => setProducts(result.data)); }, [query]);
  return <section><h1>Results for “{query}”</h1><ProductGrid products={products} /></section>;
}
''')
page('account/page.tsx', "import { useEffect, useState } from 'react';\nimport { me } from '../../lib/api/account';\n", '''
export default function AccountPage() {
  const [account, setAccount] = useState<{ name: string; email: string } | undefined>();
  useEffect(() => { void me().then(result => setAccount(result.data)); }, []);
  return account ? <section><h1>{account.name}</h1><p>{account.email}</p></section> : null;
}
''')
page('account/addresses/page.tsx', "import { useState } from 'react';\nimport { addAddress } from '../../../lib/api/account';\n", '''
export default function AddressesPage() {
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [postcode, setPostcode] = useState('');
  return (
    <form onSubmit={event => { event.preventDefault(); void addAddress({ line1, city, postcode, country: 'DE' }); }}>
      <input value={line1} onChange={event => setLine1(event.target.value)} />
      <input value={city} onChange={event => setCity(event.target.value)} />
      <input value={postcode} onChange={event => setPostcode(event.target.value)} />
      <button className="button">Save address</button>
    </form>
  );
}
''')
page('register/page.tsx', "import { useState } from 'react';\nimport { register } from '../../lib/api/account';\n", '''
export default function RegisterPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form onSubmit={event => { event.preventDefault(); void register(name, email, password); }}>
      <input value={name} onChange={event => setName(event.target.value)} />
      <input type="email" value={email} onChange={event => setEmail(event.target.value)} />
      <input type="password" value={password} onChange={event => setPassword(event.target.value)} />
      <button className="button primary">Create account</button>
    </form>
  );
}
''')
page('admin/page.tsx', "import { useEffect, useState } from 'react';\nimport { salesReport } from '../../lib/api/admin';\nimport { SalesChart } from '../../components/admin/SalesChart';\n", '''
export default function AdminHome() {
  const [days, setDays] = useState<{ day: string; orders: number; revenue_cents: number }[]>([]);
  useEffect(() => { void salesReport().then(setDays); }, []);
  return <section><h1>Sales</h1><SalesChart days={days} /></section>;
}
''')
page('admin/orders/page.tsx', "import { useEffect, useState } from 'react';\nimport { adminOrders } from '../../../lib/api/admin';\nimport { OrderTable } from '../../../components/admin/OrderTable';\nimport type { Order } from '../../../lib/types';\n", '''
export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<(Order & { id: number })[]>([]);
  useEffect(() => { void adminOrders().then(result => setOrders(result.data as (Order & { id: number })[])); }, []);
  return <section><h1>Orders</h1><OrderTable orders={orders} /></section>;
}
''')
page('admin/products/page.tsx', "import { useEffect, useState } from 'react';\nimport { adminProducts } from '../../../lib/api/admin';\nimport { ProductTable } from '../../../components/admin/ProductTable';\nimport type { Product } from '../../../lib/types';\n", '''
export default function AdminProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  useEffect(() => { void adminProducts().then(result => setProducts(result.data)); }, []);
  return <section><h1>Products</h1><ProductTable products={products} /></section>;
}
''')
put('README.md', '', ['''# Storefront

An online shop: a Laravel API (`api/`) and a Next.js storefront (`web/`).

```sh
cd api && composer install && php artisan migrate --seed && php artisan serve
cd web && npm install && npm run dev
```
'''])
put('.gitignore', '', ['vendor/\nnode_modules/\n.next/\n.env\n'])

# ------------------------------------------------------------------------------------------------------------ HISTORY
# Who owns what (the author of most commits there), and the order things were built in.
def owner_of(path):
    if path.startswith('web/src/components/admin') or path.startswith('web/src/app/admin'): return 'leo'
    if path.startswith('web/src/components/checkout') or 'checkout' in path and path.startswith('web/'): return 'tom'
    if path.startswith('web/src/components/reviews') or path.startswith('web/src/app/account') or path.startswith('web/src/app/register'): return 'sara'
    if path.startswith('web/'): return rng.choice(['tom', 'sara'])
    if 'Payments' in path or 'Refund' in path or 'Payment' in path or 'Stripe' in path: return 'jonas'
    if 'Checkout' in path or 'Pricing' in path or 'Tax' in path or 'Order' in path or 'Cart' in path: return 'ana'
    if 'Catalog' in path or 'Search' in path or 'Product' in path or 'Categor' in path or 'Review' in path: return 'priya'
    if 'Admin' in path or 'Report' in path or 'Jobs' in path or 'Console' in path or 'Inventory' in path or 'Shipping' in path or 'Label' in path: return 'leo'
    return rng.choice(['ana', 'priya', 'leo'])

PHASES = [
    ('Set up the Laravel API and the Next.js storefront', lambda p: p in ('README.md', '.gitignore', A + 'composer.json', A + 'bootstrap/app.php', A + 'routes/web.php', A + 'app/Http/Controllers/Controller.php', A + 'tests/TestCase.php', W + 'package.json', W + 'tsconfig.json', W + 'next.config.ts', W + 'src/app/layout.tsx') or p.startswith(A + 'config/')),
    ('Users and customers', lambda p: any(k in p for k in ('Models/User.', 'Models/Customer.', 'create_users', 'create_customers', 'UserFactory'))),
    ('Catalog: products, variants and categories', lambda p: any(k in p for k in ('Models/Product', 'Models/Category', 'create_products', 'create_product_variants', 'create_categories', 'Catalog/', 'ProductController', 'CategoryController', 'ProductResource', 'CategoryResource', 'ProductFactory', 'lib/api/products', 'lib/api/client', 'lib/types', 'components/product/ProductCard', 'components/product/ProductGrid', 'components/product/PriceTag', 'app/page.tsx', 'app/products/page.tsx', 'lib/money'))),
    ('Product page', lambda p: any(k in p for k in ('app/products/[slug]/page.tsx', 'VariantPicker', 'components/layout/'))),
    ('Cart', lambda p: any(k in p for k in ('Models/Cart', 'create_carts', 'create_cart_items', 'Cart/CartService', 'CartController', 'CartResource', 'AddCartItemRequest', 'lib/api/cart', 'useCart', 'components/cart/', 'app/cart/', 'AddToCartButton', 'CartTest'))),
    ('Inventory levels and reservations', lambda p: any(k in p for k in ('InventoryLevel', 'create_inventory_levels', 'Inventory/'))),
    ('Checkout: pricing, tax and shipping', lambda p: any(k in p for k in ('Checkout/', 'TaxRate', 'create_tax_rates', 'ShippingQuotes', 'CheckoutController', 'lib/api/shipping', 'components/checkout/ShippingOptions', 'components/checkout/OrderSummary', 'PricingServiceTest', 'TaxCalculatorTest'))),
    ('Orders and payments with Stripe', lambda p: any(k in p for k in ('Models/Order', 'create_orders', 'create_order_items', 'Models/Payment', 'create_payments', 'Payments/PaymentGateway', 'StripeClient', 'OrderController', 'OrderResource', 'PlaceOrderRequest', 'OrderPlaced', 'PaymentWebhook', 'lib/api/orders', 'components/checkout/', 'app/checkout/', 'CheckoutTest', 'OrderFactory', 'routes/api.php'))),
    ('Order emails and payment capture', lambda p: any(k in p for k in ('Mail/OrderConfirmation', 'SendOrderConfirmation', 'CapturePayment', 'PaymentCaptured', 'ReconcilePayments'))),
    ('Customer accounts and order history', lambda p: any(k in p for k in ('AccountController', 'CustomerService', 'CustomerResource', 'RegisterRequest', 'StoreAddressRequest', 'Models/Address', 'create_addresses', 'lib/api/account', 'app/account', 'app/register', 'app/orders', 'AccountTest', 'OrderPolicy'))),
    ('Reviews', lambda p: any(k in p for k in ('Review',))),
    ('Search', lambda p: any(k in p for k in ('Search',))),
    ('Wishlist', lambda p: any(k in p for k in ('Wishlist',))),
    ('Shipping labels and tracking', lambda p: any(k in p for k in ('Shipment', 'create_shipments', 'LabelPrinter', 'ShippingUpdate', 'OrderShipped'))),
    ('Admin: products, orders and refunds', lambda p: any(k in p for k in ('Admin', 'Refund', 'create_refunds', 'lib/api/admin', 'app/admin', 'components/admin'))),
    ('Jobs, schedules and imports', lambda p: True),
]
created = {}
events = []  # (message, author, {path: parts})
remaining = set(FILES)
for message, test in PHASES:
    paths = sorted(p for p in remaining if test(p))
    remaining -= set(paths)
    step = {}
    for p in paths:
        n = len(FILES[p]['parts'])
        step[p] = max(1, (n + 1) // 2) if n > 1 else 1
        created[p] = step[p]
    lead = max(set(owner_of(p) for p in paths), key=lambda who: sum(owner_of(p) == who for p in paths)) if paths else 'ana'
    events.append((message, lead, step))
# Then: the remaining parts arrive one at a time, by whoever owns the file (now and then an agent), and the busiest
# files (checkout, pricing, the order controller, the API routes) keep changing.
growth = [(p, i) for p in FILES for i in range(created[p], len(FILES[p]['parts']))]
rng.shuffle(growth)
# Each file still grows in order: its n-th appearance writes its n-th next part.
seen = {}
for k, (p, _) in enumerate(growth):
    seen[p] = seen.get(p, created[p]) + 1
    growth[k] = (p, seen[p] - 1)
VERBS = {'php': ['Add', 'Handle', 'Support', 'Cover', 'Allow'], 'ts': ['Add', 'Show', 'Wire', 'Support']}
for p, i in growth:
    events.append((None, None, {p: i + 1}))
# Busy files: small fixes on the checkout path, so they are the hotspots.
HOT = [A + 'app/Services/Checkout/CheckoutService.php', A + 'app/Services/Checkout/PricingService.php', A + 'app/Http/Controllers/OrderController.php', W + 'src/components/checkout/CheckoutForm.tsx']
NOTES = ['Amounts are in cents, always.', 'Keep this in one transaction.', 'Prices come from the API.', 'Totals are computed once, here.', 'Stock is reserved before the charge.', 'Never trust the client total.', 'Currency follows the cart.']
for k in range(18):
    at = rng.randint(int(len(events) * 0.5), len(events))
    events.insert(at, ('hot', rng.choice(HOT), k))

def fmt(path):
    base = os.path.basename(path).rsplit('.', 1)[0]
    return base.replace('[', '').replace(']', '')

def run(*args, env=None, cwd=None):
    return subprocess.run(args, cwd=cwd or OUT, env=env, check=True, capture_output=True, text=True).stdout

shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)
run('git', 'init', '-q', '-b', 'main')
run('git', 'config', 'user.name', 'Storefront')
run('git', 'config', 'user.email', 'dev@storefront.dev')
run('git', 'remote', 'add', 'origin', 'https://github.com/storefront-dev/storefront.git')

start = datetime(2025, 8, 4, 9, 30)
end = datetime(2026, 10, 9, 17, 0)
state = {}  # path -> parts written
total = len(events)
def when(index):
    d = start + (end - start) * (index / max(1, total - 1))
    d = d.replace(hour=rng.randint(9, 18), minute=rng.randint(0, 59))
    while d.weekday() >= 5: d += timedelta(days=1)
    return d

AGENT_SHARE = {'claude': 0.24, 'codex': 0.09, 'cursor': 0.06}
def commit(message, who, date, coauthor=None):
    name, email = PEOPLE[who]
    env = {**os.environ, 'GIT_AUTHOR_NAME': name, 'GIT_AUTHOR_EMAIL': email, 'GIT_COMMITTER_NAME': name, 'GIT_COMMITTER_EMAIL': email,
           'GIT_AUTHOR_DATE': date.isoformat(), 'GIT_COMMITTER_DATE': date.isoformat()}
    body = f'{message}\n\nCo-Authored-By: {PEOPLE[coauthor][0]} <{PEOPLE[coauthor][1]}>\n' if coauthor else message
    run('git', 'add', '-A', env=env)
    run('git', 'commit', '-q', '-m', body, env=env)

def apply_hot(p, k):
    path = os.path.join(OUT, p)
    text = open(path).read()
    mark = '// ' if p.endswith('.tsx') else '    // '
    text = re.sub(r'^(    )?// Note: .*\n', '', text, flags=re.M)
    note = f'{mark}Note: {NOTES[k % len(NOTES)]} (incident {k + 1})\n'
    if p.endswith('.tsx'):
        text = text.replace("'use client';\n", "'use client';\n" + note, 1)
    else:
        text = text.replace('{\n', '{\n' + note, 1)
    open(path, 'w').write(text)

pr = PR_START
last = start
for index, (message, who, step) in enumerate(events):
    if message == 'hot':
        apply_hot(who, step)
        pr += 1
        last = max(last + timedelta(minutes=7), when(index))
        commit(f'Fix {fmt(who)} after the checkout incident (#{pr})', owner_of(who), last)
        continue
    for p, n in step.items():
        os.makedirs(os.path.dirname(os.path.join(OUT, p)) or OUT, exist_ok=True)
        with open(os.path.join(OUT, p), 'w') as fh: fh.write(render(p, n))
        state[p] = n
    p = next(iter(step))
    if message is None:
        who = owner_of(p)
        if who in ('tom', 'sara') and rng.random() < 0.45: who = 'sara' if who == 'tom' else 'tom'
        elif rng.random() < 0.2: who = rng.choice(['ana', 'priya', 'leo', 'jonas', 'tom', 'sara'])
        roll = rng.random()
        if index > total * 0.45:  # agents arrive later in the year
            for agent, share in AGENT_SHARE.items():
                if roll < share: who = agent; break
                roll -= share
        ext = 'ts' if p.endswith(('.ts', '.tsx')) else 'php'
        message = f'{rng.choice(VERBS[ext])} {fmt(p)} {rng.choice(["edge cases", "the next step", "a missing case", "what the review asked", "the new flow"])}'
    pr += 1
    date = last = max(last + timedelta(minutes=7), when(index))
    coauthor = 'claude' if who in ('ana', 'priya') and rng.random() < 0.18 and index > total * 0.4 else None
    commit(f'{message} (#{pr})', who, date, coauthor)

print('main:', run('git', 'rev-list', '--count', 'HEAD').strip(), 'commits,', len(FILES), 'files, last PR', pr)

# --------------------------------------------------------------------------------------------- THE AGENT'S PULL REQUEST
# claude/coupons-and-gift-cards: coupons and gift cards at checkout, opened by Claude Code. Real code, real diff.
run('git', 'checkout', '-q', '-b', 'claude/coupons-and-gift-cards')
BR = {}
def bput(path, content): BR[path] = content
MODELS2 = {
    'Coupon': (['code', 'kind', 'amount', 'min_subtotal_cents', 'starts_at', 'ends_at', 'max_redemptions'], [('redemptions', 'hasMany', 'CouponRedemption')]),
    'CouponRedemption': (['coupon_id', 'order_id', 'customer_id', 'discount_cents'], [('coupon', 'belongsTo', 'Coupon'), ('order', 'belongsTo', 'Order')]),
    'GiftCard': (['code', 'balance_cents', 'currency', 'expires_at', 'customer_id'], [('customer', 'belongsTo', 'Customer')]),
}
for i, (model, (fillable, rels)) in enumerate(MODELS2.items()):
    uses = sorted({REL_TYPES[k] for _, k, _ in rels})
    content = '<?php\n\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Model;\n' + ''.join(f'use Illuminate\\Database\\Eloquent\\Relations\\{u};\n' for u in uses)
    content += f'\nclass {model} extends Model\n{{\n    protected $fillable = [{", ".join(repr(x) for x in fillable)}];\n'
    for rel, kind, target in rels:
        content += f'\n    public function {rel}(): {REL_TYPES[kind]}\n    {{\n        return $this->{kind}({target}::class);\n    }}\n'
    if model == 'Coupon':
        content += '''
    public function isActive(?\\DateTimeInterface $at = null): bool
    {
        $at ??= now();
        return (! $this->starts_at || $this->starts_at <= $at) && (! $this->ends_at || $this->ends_at > $at)
            && (! $this->max_redemptions || $this->redemptions()->count() < $this->max_redemptions);
    }
'''
    content += '}\n'
    bput(f'{A}app/Models/{model}.php', content)
    table = plural(snake(model))
    cols = ''.join(column(c) for c in fillable)
    bput(f'{A}database/migrations/2026_10_{12 + i:02d}_000000_create_{table}_table.php', f'''<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{{
    public function up(): void
    {{
        Schema::create('{table}', function (Blueprint $table) {{
            $table->id();
{cols}            $table->timestamps();
        }});
    }}

    public function down(): void
    {{
        Schema::dropIfExists('{table}');
    }}
}};
''')
bput(f'{A}database/migrations/2026_10_15_000000_add_discount_to_orders_table.php', '''<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('orders', function (Blueprint $table) {
            $table->unsignedInteger('discount_cents')->default(0);
            $table->unsignedInteger('gift_card_cents')->default(0);
            $table->string('coupon_code')->nullable();
        });
    }
};
''')
bput(f'{A}app/Services/Promotions/CouponService.php', '''<?php

namespace App\\Services\\Promotions;

use App\\Models\\Cart;
use App\\Models\\Coupon;
use App\\Models\\CouponRedemption;
use App\\Models\\Order;

class CouponService
{
    public function find(string $code): ?Coupon
    {
        return Coupon::where('code', strtoupper(trim($code)))->first();
    }

    /** What a coupon takes off a cart, or why it does not apply. */
    public function discountFor(Cart $cart, string $code): Discount
    {
        $coupon = $this->find($code);
        if (! $coupon || ! $coupon->isActive()) {
            return Discount::refused('This code is not valid');
        }
        $subtotal = $cart->subtotalCents();
        if ($subtotal < $coupon->min_subtotal_cents) {
            return Discount::refused('Spend a little more to use this code');
        }
        $cents = $coupon->kind === 'percent' ? intdiv($subtotal * $coupon->amount, 100) : min($coupon->amount, $subtotal);
        return Discount::of($coupon, $cents);
    }

    public function redeem(Coupon $coupon, Order $order, int $discountCents): CouponRedemption
    {
        return CouponRedemption::create(['coupon_id' => $coupon->id, 'order_id' => $order->id, 'customer_id' => $order->customer_id, 'discount_cents' => $discountCents]);
    }
}
''')
bput(f'{A}app/Services/Promotions/Discount.php', '''<?php

namespace App\\Services\\Promotions;

use App\\Models\\Coupon;

final class Discount
{
    private function __construct(public readonly ?Coupon $coupon, public readonly int $cents, public readonly ?string $reason) {}

    public static function of(Coupon $coupon, int $cents): self
    {
        return new self($coupon, $cents, null);
    }

    public static function refused(string $reason): self
    {
        return new self(null, 0, $reason);
    }

    public function applies(): bool
    {
        return $this->coupon !== null;
    }
}
''')
bput(f'{A}app/Services/Promotions/GiftCardService.php', '''<?php

namespace App\\Services\\Promotions;

use App\\Models\\GiftCard;
use Illuminate\\Support\\Facades\\DB;

class GiftCardService
{
    public function balance(string $code): int
    {
        return GiftCard::where('code', $code)->where(fn ($q) => $q->whereNull('expires_at')->orWhere('expires_at', '>', now()))->value('balance_cents') ?? 0;
    }

    /** Takes up to $cents from the card; returns what it took. */
    public function spend(string $code, int $cents): int
    {
        return DB::transaction(function () use ($code, $cents) {
            $card = GiftCard::where('code', $code)->lockForUpdate()->firstOrFail();
            $taken = min($card->balance_cents, $cents);
            $card->decrement('balance_cents', $taken);
            return $taken;
        });
    }
}
''')
bput(f'{A}app/Http/Controllers/PromotionController.php', '''<?php

namespace App\\Http\\Controllers;

use App\\Http\\Requests\\ApplyCouponRequest;
use App\\Services\\Cart\\CartService;
use App\\Services\\Promotions\\CouponService;
use App\\Services\\Promotions\\GiftCardService;
use Illuminate\\Http\\Request;

class PromotionController extends Controller
{
    public function __construct(
        private CouponService $coupons,
        private GiftCardService $giftCards,
        private CartService $carts,
    ) {}

    public function applyCoupon(ApplyCouponRequest $request): array
    {
        $discount = $this->coupons->discountFor($this->carts->current($request->cookie('cart')), $request->string('code'));
        return ['applies' => $discount->applies(), 'discount_cents' => $discount->cents, 'reason' => $discount->reason];
    }

    public function giftCardBalance(Request $request, string $code): array
    {
        return ['balance_cents' => $this->giftCards->balance($code)];
    }
}
''')
bput(f'{A}app/Http/Controllers/Admin/CouponAdminController.php', '''<?php

namespace App\\Http\\Controllers\\Admin;

use App\\Http\\Controllers\\Controller;
use App\\Http\\Requests\\StoreCouponRequest;
use App\\Models\\Coupon;

class CouponAdminController extends Controller
{
    public function index()
    {
        return Coupon::withCount('redemptions')->latest()->paginate(50);
    }

    public function store(StoreCouponRequest $request): Coupon
    {
        return Coupon::create([...$request->validated(), 'code' => strtoupper($request->string('code'))]);
    }
}
''')
for name, rules in {'ApplyCouponRequest': "'code' => ['required', 'string', 'max:40']",
                    'StoreCouponRequest': "'code' => ['required', 'alpha_dash', 'unique:coupons'], 'kind' => ['required', 'in:percent,fixed'], 'amount' => ['required', 'integer', 'min:1'], 'min_subtotal_cents' => ['integer', 'min:0']"}.items():
    bput(f'{A}app/Http/Requests/{name}.php', f'''<?php

namespace App\\Http\\Requests;

use Illuminate\\Foundation\\Http\\FormRequest;

class {name} extends FormRequest
{{
    public function rules(): array
    {{
        return [{rules}];
    }}
}}
''')
bput(f'{A}app/Events/CouponRedeemed.php', '''<?php

namespace App\\Events;

use App\\Models\\CouponRedemption;
use Illuminate\\Foundation\\Events\\Dispatchable;

class CouponRedeemed
{
    use Dispatchable;

    public function __construct(public CouponRedemption $redemption) {}
}
''')
bput(f'{A}app/Jobs/ExpireGiftCards.php', '''<?php

namespace App\\Jobs;

use App\\Models\\GiftCard;
use Illuminate\\Bus\\Queueable;
use Illuminate\\Contracts\\Queue\\ShouldQueue;
use Illuminate\\Foundation\\Bus\\Dispatchable;

class ExpireGiftCards implements ShouldQueue
{
    use Dispatchable, Queueable;

    public function handle(): void
    {
        GiftCard::where('expires_at', '<', now())->where('balance_cents', '>', 0)->update(['balance_cents' => 0]);
    }
}
''')
for name, cases in {'Feature/CouponTest': ['applies_a_percent_coupon', 'refuses_an_expired_coupon', 'refuses_below_the_minimum', 'stops_at_max_redemptions'],
                    'Feature/GiftCardTest': ['spends_part_of_a_card', 'never_goes_below_zero'],
                    'Unit/DiscountTest': ['caps_a_fixed_discount_at_the_subtotal']}.items():
    cls = name.split('/')[1]
    bput(f'{A}tests/{name}.php', f'''<?php

namespace Tests\\{name.split("/")[0]};

use Illuminate\\Foundation\\Testing\\RefreshDatabase;
use Tests\\TestCase;

class {cls} extends TestCase
{{
    use RefreshDatabase;
''' + ''.join(f'''
    public function test_{case}(): void
    {{
        $this->markTestIncomplete('{case.replace("_", " ")}');
    }}
''' for case in cases) + '}\n')
# Changed files.
def edit(path, old, new, count=1):
    text = BR.get(path) or open(os.path.join(OUT, path)).read()
    assert old in text, (path, old[:60])
    BR[path] = text.replace(old, new, count)
edit(A + 'app/Services/Checkout/CheckoutService.php', "use App\\Services\\Payments\\PaymentGateway;\n", "use App\\Services\\Payments\\PaymentGateway;\nuse App\\Services\\Promotions\\CouponService;\nuse App\\Services\\Promotions\\GiftCardService;\n")
edit(A + 'app/Services/Checkout/CheckoutService.php', "        private PaymentGateway $payments,\n", "        private PaymentGateway $payments,\n        private CouponService $coupons,\n        private GiftCardService $giftCards,\n")
edit(A + 'app/Services/Checkout/CheckoutService.php', "        $totals = $this->pricing->totals($cart, $details['shipping_method']);\n        $this->inventory->reserve($cart);\n",
     "        $discount = isset($details['coupon']) ? $this->coupons->discountFor($cart, $details['coupon']) : null;\n        $totals = $this->pricing->totals($cart, $details['shipping_method'], $discount?->cents ?? 0);\n        $giftCard = isset($details['gift_card']) ? $this->giftCards->spend($details['gift_card'], $totals->total) : 0;\n        $this->inventory->reserve($cart);\n")
edit(A + 'app/Services/Checkout/CheckoutService.php', "                'total_cents' => $totals->total,\n", "                'discount_cents' => $totals->discount,\n                'gift_card_cents' => $giftCard,\n                'coupon_code' => $discount?->coupon?->code,\n                'total_cents' => $totals->total - $giftCard,\n")
edit(A + 'app/Services/Checkout/CheckoutService.php', "        $this->payments->charge($order, $details['payment_method']);\n",
     "        if ($discount?->applies()) {\n            $this->coupons->redeem($discount->coupon, $order, $discount->cents);\n        }\n        if ($order->total_cents > 0) {\n            $this->payments->charge($order, $details['payment_method']);\n        }\n")
edit(A + 'app/Services/Checkout/PricingService.php', "    public function totals(Cart $cart, string $shippingMethod): Totals\n    {\n        $subtotal = $cart->subtotalCents();\n        $shipping = $this->shipping->priceFor($cart, $shippingMethod);\n        $tax = $this->taxes->forCart($cart, $subtotal + $shipping);\n\n        return new Totals($subtotal, $tax, $shipping, $subtotal + $tax + $shipping);",
     "    public function totals(Cart $cart, string $shippingMethod, int $discountCents = 0): Totals\n    {\n        $subtotal = $cart->subtotalCents();\n        $discount = min($discountCents, $subtotal);\n        $shipping = $this->shipping->priceFor($cart, $shippingMethod);\n        $tax = $this->taxes->forCart($cart, $subtotal - $discount + $shipping);\n\n        return new Totals($subtotal, $tax, $shipping, $subtotal - $discount + $tax + $shipping, $discount);")
edit(A + 'app/Services/Checkout/Totals.php', "        public readonly int $total,\n", "        public readonly int $total,\n        public readonly int $discount = 0,\n")
edit(A + 'app/Services/Checkout/CheckoutService.php', "        return ['subtotal' => $totals->subtotal, 'tax' => $totals->tax, 'shipping' => $totals->shipping, 'total' => $totals->total];",
     "        return ['subtotal' => $totals->subtotal, 'discount' => $totals->discount, 'tax' => $totals->tax, 'shipping' => $totals->shipping, 'total' => $totals->total];")
edit(A + 'app/Http/Requests/PlaceOrderRequest.php', "'payment_method' => ['required', 'string']", "'payment_method' => ['required_unless:gift_card_covers,true', 'string'], 'coupon' => ['nullable', 'string', 'max:40'], 'gift_card' => ['nullable', 'string', 'size:16']")
edit(A + 'app/Models/Order.php', "'total_cents', ", "'discount_cents', 'gift_card_cents', 'coupon_code', 'total_cents', ")
edit(A + 'app/Http/Resources/OrderResource.php', "'total_cents' => $this->total_cents, ", "'discount_cents' => $this->discount_cents, 'gift_card_cents' => $this->gift_card_cents, 'total_cents' => $this->total_cents, ")
edit(A + 'routes/api.php', "use App\\Http\\Controllers\\PaymentWebhookController;\n", "use App\\Http\\Controllers\\PaymentWebhookController;\nuse App\\Http\\Controllers\\PromotionController;\nuse App\\Http\\Controllers\\Admin\\CouponAdminController;\n")
edit(A + 'routes/api.php', "Route::post('orders', [OrderController::class, 'store']);\n", "Route::post('orders', [OrderController::class, 'store']);\nRoute::post('checkout/coupon', [PromotionController::class, 'applyCoupon']);\nRoute::get('gift-cards/{code}', [PromotionController::class, 'giftCardBalance']);\n")
edit(A + 'routes/api.php', "    Route::get('reports/sales', [ReportController::class, 'sales']);\n", "    Route::get('reports/sales', [ReportController::class, 'sales']);\n    Route::get('coupons', [CouponAdminController::class, 'index']);\n    Route::post('coupons', [CouponAdminController::class, 'store']);\n")
edit(A + 'routes/console.php', "use App\\Jobs\\RebuildSearchIndex;\n", "use App\\Jobs\\ExpireGiftCards;\nuse App\\Jobs\\RebuildSearchIndex;\n")
edit(A + 'routes/console.php', "Schedule::job(new RebuildSearchIndex)->weekly();\n", "Schedule::job(new RebuildSearchIndex)->weekly();\nSchedule::job(new ExpireGiftCards)->dailyAt('03:00');\n")
edit(A + 'tests/Feature/CheckoutTest.php', "    public function test_places_an_order_from_the_cart", "    public function test_takes_a_coupon_off_the_total(): void\n    {\n        $this->markTestIncomplete('takes a coupon off the total');\n    }\n\n    public function test_places_an_order_from_the_cart")
edit(A + 'tests/Unit/PricingServiceTest.php', "    public function test_discounts_ten_or_more", "    public function test_taxes_after_the_discount(): void\n    {\n        $this->markTestIncomplete('taxes after the discount');\n    }\n\n    public function test_discounts_ten_or_more")
bput(W + 'src/lib/api/promotions.ts', '''\'use client\';
import { apiFetch } from './client';

export interface CouponResult { applies: boolean; discount_cents: number; reason?: string }

export function applyCoupon(code: string): Promise<CouponResult> {
  return apiFetch('/api/checkout/coupon', { method: 'POST', body: JSON.stringify({ code }) });
}

export function giftCardBalance(code: string): Promise<{ balance_cents: number }> {
  return apiFetch(`/api/gift-cards/${code}`);
}
''')
bput(W + 'src/components/checkout/CouponField.tsx', '''\'use client\';
import { useState } from 'react';
import { applyCoupon, type CouponResult } from '../../lib/api/promotions';
import { formatMoney } from '../../lib/money';

export function CouponField({ onApplied }: { onApplied: (code: string, discountCents: number) => void }) {
  const [code, setCode] = useState('');
  const [result, setResult] = useState<CouponResult | undefined>();
  async function apply() {
    const answer = await applyCoupon(code);
    setResult(answer);
    if (answer.applies) onApplied(code, answer.discount_cents);
  }
  return (
    <div className="coupon-field">
      <input value={code} onChange={event => setCode(event.target.value.toUpperCase())} placeholder="Coupon code" />
      <button type="button" className="button" onClick={apply}>Apply</button>
      {result && <p className={result.applies ? 'ok' : 'error'}>{result.applies ? `−${formatMoney(result.discount_cents)}` : result.reason}</p>}
    </div>
  );
}
''')
bput(W + 'src/components/checkout/GiftCardField.tsx', '''\'use client\';
import { useState } from 'react';
import { giftCardBalance } from '../../lib/api/promotions';
import { formatMoney } from '../../lib/money';

export function GiftCardField({ onChange }: { onChange: (code: string | undefined) => void }) {
  const [code, setCode] = useState('');
  const [balance, setBalance] = useState<number | undefined>();
  async function check() {
    const { balance_cents } = await giftCardBalance(code);
    setBalance(balance_cents);
    onChange(balance_cents > 0 ? code : undefined);
  }
  return (
    <div className="gift-card-field">
      <input value={code} onChange={event => setCode(event.target.value)} placeholder="Gift card" maxLength={16} />
      <button type="button" className="button" onClick={check}>Use</button>
      {balance !== undefined && <p>{balance > 0 ? `${formatMoney(balance)} available` : 'No balance left'}</p>}
    </div>
  );
}
''')
bput(W + 'src/components/admin/CouponTable.tsx', '''\'use client\';
import { formatMoney } from '../../lib/money';

export interface CouponRow { code: string; kind: 'percent' | 'fixed'; amount: number; redemptions_count: number }

export function CouponTable({ coupons }: { coupons: CouponRow[] }) {
  return <table className="admin-table"><tbody>{coupons.map(coupon => <tr key={coupon.code}><td>{coupon.code}</td><td>{coupon.kind === 'percent' ? `${coupon.amount}%` : formatMoney(coupon.amount)}</td><td>{coupon.redemptions_count} used</td></tr>)}</tbody></table>;
}
''')
bput(W + 'src/app/admin/coupons/page.tsx', '''\'use client\';
import { useEffect, useState } from 'react';
import { listCoupons } from '../../../lib/api/admin';
import { CouponTable, type CouponRow } from '../../../components/admin/CouponTable';

export default function AdminCouponsPage() {
  const [coupons, setCoupons] = useState<CouponRow[]>([]);
  useEffect(() => { void listCoupons().then(result => setCoupons(result.data)); }, []);
  return <section><h1>Coupons</h1><CouponTable coupons={coupons} /></section>;
}
''')
edit(W + 'src/lib/api/admin.ts', "export function salesReport", "export function listCoupons(): Promise<{ data: { code: string; kind: 'percent' | 'fixed'; amount: number; redemptions_count: number }[] }> {\n  return apiFetch('/api/admin/coupons');\n}\n\nexport function salesReport")
edit(W + 'src/lib/api/orders.ts', "export interface OrderDetails { shipping_method: 'standard' | 'express' | 'pickup'; payment_method: string }", "export interface OrderDetails { shipping_method: 'standard' | 'express' | 'pickup'; payment_method: string; coupon?: string; gift_card?: string }")
edit(W + 'src/lib/types.ts', "export interface Quote { subtotal: number; tax: number; shipping: number; total: number }", "export interface Quote { subtotal: number; discount: number; tax: number; shipping: number; total: number }")
edit(W + 'src/components/checkout/CheckoutForm.tsx', "import { PaymentFields } from './PaymentFields';\n", "import { PaymentFields } from './PaymentFields';\nimport { CouponField } from './CouponField';\nimport { GiftCardField } from './GiftCardField';\n")
edit(W + 'src/components/checkout/CheckoutForm.tsx', "  const [paymentMethod, setPaymentMethod] = useState('');\n", "  const [paymentMethod, setPaymentMethod] = useState('');\n  const [coupon, setCoupon] = useState<string | undefined>();\n  const [giftCard, setGiftCard] = useState<string | undefined>();\n")
edit(W + 'src/components/checkout/CheckoutForm.tsx', "      <PaymentFields onReady={setPaymentMethod} />\n      <PlaceOrderButton details={{ shipping_method: shipping, payment_method: paymentMethod }}",
     "      <CouponField onApplied={code => setCoupon(code)} />\n      <GiftCardField onChange={setGiftCard} />\n      <PaymentFields onReady={setPaymentMethod} />\n      <PlaceOrderButton details={{ shipping_method: shipping, payment_method: paymentMethod, coupon, gift_card: giftCard }}")
edit(W + 'src/components/checkout/OrderSummary.tsx', "      <dt>Shipping</dt>", "      {totals.discount > 0 && <><dt>Discount</dt><dd>−{formatMoney(totals.discount)}</dd></>}\n      <dt>Shipping</dt>")
edit(W + 'src/components/cart/CartSummary.tsx', "      <Link className=\"button primary\" href=\"/checkout\">Checkout</Link>", "      <p className=\"hint\">Have a coupon or a gift card? Add it at checkout.</p>\n      <Link className=\"button primary\" href=\"/checkout\">Checkout</Link>")
edit(W + 'src/lib/money.ts', "export function sumCents", "export function percentOff(cents: number, percent: number): number {\n  return Math.floor((cents * percent) / 100);\n}\n\nexport function sumCents")

def bwrite(paths):
    for p in paths:
        full = os.path.join(OUT, p)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        open(full, 'w').write(BR[p])
STEPS = [
    ('Add coupons and gift cards: models and migrations', [p for p in BR if '/Models/' in p or 'migrations' in p]),
    ('Price coupons and gift cards at checkout', [p for p in BR if 'Services/' in p or 'PlaceOrderRequest' in p or 'OrderResource' in p or 'Promotion' in p or 'ApplyCoupon' in p or 'routes/' in p or 'Events/' in p or 'Jobs/' in p]),
    ('Coupon and gift card fields in the checkout form', [p for p in BR if p.startswith(W) and 'admin' not in p]),
    ('Admin: create coupons and see their use', [p for p in BR if 'admin' in p.lower() or 'Admin' in p or 'StoreCoupon' in p]),
    ('Tests for coupons, gift cards and discounted totals', [p for p in BR if '/tests/' in p]),
]
done = set()
d = datetime(2026, 10, 16, 10, 12)
for message, paths in STEPS:
    paths = [p for p in paths if p not in done]
    bwrite(paths); done |= set(paths)
    commit(message, 'claude', d)
    d += timedelta(minutes=rng.randint(9, 26))
left = [p for p in BR if p not in done]
if left:
    bwrite(left); commit('Wire the remaining pieces', 'claude', d)
stat = run('git', 'diff', '--shortstat', 'main...HEAD').strip()
print('branch:', stat)
run('git', 'checkout', '-q', 'main')
