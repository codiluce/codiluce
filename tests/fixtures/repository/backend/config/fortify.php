<?php

use Laravel\Fortify\Features;

return [
    'guard' => 'web',
    'prefix' => '',
    'middleware' => ['web'],
    'views' => true,
    'features' => [
        Features::registration(),
    ],
];
