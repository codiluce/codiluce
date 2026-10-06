<?php

namespace App\Actions\Fortify;

use App\Models\User;

class CreateNewUser
{
    public function create(array $input): User
    {
        return User::create($input);
    }
}
