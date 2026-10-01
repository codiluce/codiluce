<?php
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\AuthController;
Route::prefix('settings')->group(function () {
    Route::get('user', [AuthController::class, 'user']);
});
