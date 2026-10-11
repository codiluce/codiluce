import {readFile} from 'node:fs/promises';
import type {ApplicationInput,RawConfig} from '../../src/core/config.js';
import {jvmDotnetWorkload} from './jvm-dotnet-workload.js';
import {rustWorkload} from './rust-workload.js';

/** Authored source contracts, never runnable target applications. All packs
 * share one scan so application boundaries, caches and original source ranges
 * are exercised together. Framework dependencies are literal inputs only. */
export async function mixedWorkload(count=1) {
 if(!Number.isSafeInteger(count)||count<1||count>32)throw Error('Mixed resource count must be 1–32');
 const files:Record<string,string>={},applications:ApplicationInput[]=[],routes:{application:string;path:string}[]=[];
 for(const [prefix,workload]of [['jvm',jvmDotnetWorkload(count)],['rust',rustWorkload(count)]]as const){
  for(const [file,content]of Object.entries(workload.files))files[`${prefix}/${file}`]=content;
  for(const app of workload.config.applications!)applications.push({...app,name:`${prefix}-${app.name}`,path:`${prefix}/${app.path}`});
 }
 const origin=(name:string)=>`https://${name}.mixed.test`;
 const add=(name:string,frameworks:string[]=[],ecosystems:string[]=[])=>applications.push({name,path:name,frameworks,ecosystems,apiOrigins:[origin(name)]});
 const calls:string[][]=Array.from({length:count},()=>[]);
 const register=(name:string,i:number)=>{routes.push({application:name,path:`/items${i}/1`});calls[i]!.push(`fetch('${origin(name)}/items${i}/1')`);};
 add('express',['express'],['node']);files['express/package.json']='{"dependencies":{"express":"5.1.0"}}';
 files['express/main.ts']='import express from "express";import {handler} from "./handlers";const app=express();'+Array.from({length:count},(_,i)=>{register('express',i);return `app.get('/items${i}/:id',handler);`;}).join('')+'app.listen(3000);';
 files['express/handlers.ts']='export function leaf(){return 1;}export function handler(req,res){return leaf();}';
 add('nest',['nest'],['node']);files['nest/package.json']='{"dependencies":{"@nestjs/core":"11.1.0","@nestjs/common":"11.1.0"}}';
 files['nest/main.ts']='import {NestFactory} from "@nestjs/core";import {Module} from "@nestjs/common";import {Items} from "./handlers";@Module({controllers:[Items]})class Root{}async function bootstrap(){const app=await NestFactory.create(Root);await app.listen(3000);}bootstrap();';
 files['nest/handlers.ts']='import {Controller,Get} from "@nestjs/common";function leaf(){return 1;}@Controller()export class Items{'+Array.from({length:count},(_,i)=>{register('nest',i);return `@Get('/items${i}/:id')show${i}(){return leaf();}`;}).join('')+'}';
 for(const [name,dependency,imports,construction,decorator]of [
  ['fastapi','fastapi==0.115.0','from fastapi import FastAPI','app=FastAPI()','@app.get("/itemsN/{id:int}")'],
  ['flask','Flask==3.1.2','from flask import Flask','app=Flask(__name__)','@app.get("/itemsN/<int:id>")'],
 ]as const){
  add(name,[name],['python']);files[`${name}/requirements.txt`]=dependency+'\n';
  files[`${name}/main.py`]=`${imports}\nfrom helpers import leaf\n${construction}\n`+Array.from({length:count},(_,i)=>{register(name,i);return `${decorator.replaceAll('N',String(i))}\ndef show${i}(id):\n    return leaf()\n`;}).join('');
  files[`${name}/helpers.py`]='def leaf():\n    return "ok"\n';
 }
 add('django',['django'],['python']);files['django/requirements.txt']='Django==5.2.7\n';files['django/settings.py']='ROOT_URLCONF="urls"\n';
 files['django/views.py']='from django.views.decorators.http import require_GET\n'+Array.from({length:count},(_,i)=>`@require_GET\ndef show${i}(request,id):\n    return "ok"\n`).join('');
 files['django/urls.py']='from django.urls import path\nfrom views import '+Array.from({length:count},(_,i)=>`show${i}`).join(',')+'\nurlpatterns=['+Array.from({length:count},(_,i)=>{register('django',i);return `path("items${i}/<int:id>",show${i})`;}).join(',')+']\n';
 add('rails',['rails'],['ruby']);files['rails/Gemfile']='gem "rails", "~>8.1.0"';files['rails/config/application.rb']='module Shop;class Application < Rails::Application;end;end';files['rails/app/controllers/application_controller.rb']='class ApplicationController < ActionController::Base;end';
 files['rails/app/controllers/items_controller.rb']='class ItemsController < ApplicationController\n'+Array.from({length:count},(_,i)=>`def show${i};end\n`).join('')+'end';
 files['rails/config/routes.rb']='Rails.application.routes.draw do\n'+Array.from({length:count},(_,i)=>{register('rails',i);return `get "items${i}/:id",to:"items#show${i}"\n`;}).join('')+'end';
 add('laravel',['laravel'],['php']);files['laravel/composer.json']='{"require":{"laravel/framework":"^12.0"}}';files['laravel/bootstrap/app.php']="<?php use Illuminate\\Foundation\\Application;return Application::configure(basePath:dirname(__DIR__))->withRouting(api:__DIR__.'/../routes/api.php',apiPrefix:'')->create();";
 files['laravel/app/Http/Controllers/ItemsController.php']='<?php namespace App\\Http\\Controllers;class ItemsController{public function show(string $id){return $this->leaf();}private function leaf(){return "ok";}}';
 files['laravel/routes/api.php']='<?php use Illuminate\\Support\\Facades\\Route;'+Array.from({length:count},(_,i)=>{register('laravel',i);return `Route::get('/items${i}/{id}',[\\App\\Http\\Controllers\\ItemsController::class,'show']);`;}).join('');
 const goProfiles=[
  ['net-http','','"net/http"','w http.ResponseWriter,r *http.Request','{}','r:=http.NewServeMux();','r.HandleFunc("GET /itemsN/{id}",api.HandlerN);','http.ListenAndServe(":8080",r)'],
  ['chi','github.com/go-chi/chi/v5 v5.2.1','"net/http";c "github.com/go-chi/chi/v5"','w http.ResponseWriter,r *http.Request','{}','r:=c.NewRouter();','r.Get("/itemsN/{id}",api.HandlerN);','http.ListenAndServe(":8080",r)'],
  ['gin','github.com/gin-gonic/gin v1.11.0','g "github.com/gin-gonic/gin"','c *g.Context','{}','r:=g.New();','r.GET("/itemsN/:id",api.HandlerN);','r.Run()'],
  ['echo4','github.com/labstack/echo/v4 v4.13.4','e "github.com/labstack/echo/v4"','c e.Context','error{return nil}','r:=e.New();','r.GET("/itemsN/:id",api.HandlerN);','r.Start(":8080")'],
  ['echo5','github.com/labstack/echo/v5 v5.4.0','e "github.com/labstack/echo/v5"','c *e.Context','error{return nil}','r:=e.New();','r.GET("/itemsN/:id",api.HandlerN);','r.Start(":8080")'],
  ['fiber2','github.com/gofiber/fiber/v2 v2.52.9','f "github.com/gofiber/fiber/v2"','c *f.Ctx','error{return nil}','r:=f.New();','r.Get("/itemsN/:id",api.HandlerN);','r.Listen(":8080")'],
  ['fiber3','github.com/gofiber/fiber/v3 v3.5.0','f "github.com/gofiber/fiber/v3"','c f.Ctx','error{return nil}','r:=f.New();','r.Get("/itemsN/:id",api.HandlerN);','r.Listen(":8080")'],
  ['gorilla','github.com/gorilla/mux v1.8.1','"net/http";m "github.com/gorilla/mux"','w http.ResponseWriter,r *http.Request','{}','r:=m.NewRouter();','r.HandleFunc("/itemsN/{id}",api.HandlerN).Methods("GET");','http.ListenAndServe(":8080",r)'],
 ];
 files['go.work']='go 1.26.0\nuse (\n'+goProfiles.map(([name])=>` ./go-${name}`).join('\n')+'\n)\n';
 for(const [profile,requirement,imports,signature,result,setup,registration,serve]of goProfiles){
  const name=`go-${profile}`;add(name,[],['go']);applications.at(-1)!.go={goos:'linux',goarch:'amd64',compiler:'gc',toolchainVersion:'1.26.0',tags:[],cgoEnabled:false};
  files[`${name}/go.mod`]=`module example.com/${name}\ngo 1.26.0\n${requirement?'require '+requirement+'\n':''}`;
  files[`${name}/main.go`]=`package main\nimport(${imports};"example.com/${name}/handlers")\nfunc main(){${setup}${Array.from({length:count},(_,i)=>{register(name,i);return registration!.replaceAll('N',String(i));}).join('')}${serve}}\n`;
  for(let i=0;i<count;i++)files[`${name}/handlers/handler${i}.go`]=`package api\nimport ${signature!.startsWith('w ')?'"net/http"':imports}\nfunc Handler${i}(${signature})${result}\n`;
 }
 add('client',[],['node']);for(let i=0;i<count;i++)files[`client/load${i}.ts`]=calls[i]!.map((call,n)=>`export function load${n}(){return ${call};}`).join('\n');
 // Declared Node workspace: two independent consumers depend on one indexed
 // package. Editing it must invalidate both consumer programs and no server.
 files['node/package.json']='{"private":true,"workspaces":["shared","web","admin"]}';
 files['node/shared/package.json']='{"name":"@mixed/shared","exports":"./index.ts"}';files['node/shared/index.ts']=`export function load(){return fetch('${origin('express')}/items0/1');}`;
 for(const name of ['web','admin']){applications.push({name:`node-${name}`,path:`node/${name}`,ecosystems:['node']});files[`node/${name}/package.json`]='{"dependencies":{"@mixed/shared":"workspace:*"}}';files[`node/${name}/index.ts`]='import {load} from "@mixed/shared";export function run(){return load();}';}
 applications.push({name:'node-shared',path:'node/shared',ecosystems:['node']});
 const structureFiles=['python.py','go.go','ruby.rb','rust.rs','Java.java','CSharp.cs','Kotlin.kt','c.c','cpp.cpp','objc.m','objc.h','objc-cpp.mm','swift.swift','scala.scala','groovy.groovy','fsharp.fs','fsharp.fsi','vbnet.vb','erb.html.erb','Counter.razor','SourceView.cshtml','template.html.liquid','generic.php','php-binding.php'];
 applications.push({name:'structure',path:'structure',ecosystems:[]});
 for(const file of structureFiles)files[`structure/${file}`]=await readFile(new URL(`../../tests/fixtures/structure/${file}`,import.meta.url),'utf8');
 const config:RawConfig={repository:{name:'mixed-release'},applications,maxFileBytes:1<<20,ignore:['**/.git/**','**/.codiluce/**','**/node_modules/**']};
 return {files,config,routes,expectedRequests:count*95+1,profileNames:applications.map(app=>app.name),structureFiles};
}
