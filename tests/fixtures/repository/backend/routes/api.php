<?php
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\AuthController as LoginController;

Route::prefix('auth')->middleware(['api'])->name('auth.')->group(function () {
    Route::post('login', [LoginController::class, 'login'])->name('login');
});
Route::get('users/{id}', [LoginController::class, 'user']);
Route::get('constrained/{id}', [LoginController::class, 'user'])->whereNumber('id');
Route::get('duplicate', [LoginController::class, 'login']);
Route::get('duplicate', [LoginController::class, 'user']);
Route::controller(LoginController::class)->prefix('session')->group(function () {
    Route::post('login', 'login');
});
Route::prefix($dynamic)->group(function () {
    Route::get('invented', [LoginController::class, 'login']);
});
if (true) { Route::get('conditional', [LoginController::class, 'login']); }
Route::resource('items', LoginController::class);
