<?php
use Illuminate\Support\Facades\Route;
Route::get('/', function () { return 'home'; });
require __DIR__ . '/settings.php';
require __DIR__ . '/profiles.php';
