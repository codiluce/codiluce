<?php
use App\Http\Controllers\AdminController;
use Illuminate\Support\Facades\Route;
use Inertia\Inertia;
Route::get('/', function () { return 'home'; });
Route::get('/admin', [AdminController::class, 'index']);
Route::post('/admin/rebuild', [AdminController::class, 'rebuild']);
Route::get('/admin/missing', [AdminController::class, 'missing']);
Route::get('/about', fn () => Inertia::render('about'));
require __DIR__ . '/settings.php';
require __DIR__ . '/profiles.php';
