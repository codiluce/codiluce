<?php
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\ProfileController;
Route::match(['GET'], 'profiles/{id}', [ProfileController::class, 'show']);
Route::put('profiles/{id}', [ProfileController::class, 'update']);
