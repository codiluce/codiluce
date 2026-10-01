<?php
namespace App\Http\Controllers;
use App\Services\AuthService;
class AuthController extends Controller {
    public function login(string $email) { return (new AuthService())->authenticate($email); }
    public function user(int $id) { return ['id' => $id]; }
}
