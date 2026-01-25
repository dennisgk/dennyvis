import React, { useEffect, useState } from "react";
import * as Babel from "@babel/standalone";

import { Button, Card, Alert } from "react-bootstrap";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";

export function compileJsx(jsx: string): string {
  const { code } = Babel.transform(jsx, {
    filename: "UserCode.jsx",
    presets: [["react", { runtime: "classic" }]],
    plugins: ["transform-modules-commonjs"],
    sourceMaps: "inline",
  });
  if (!code) throw new Error("Babel produced no output.");
  return code;
}

type Scope = {
  React: typeof React;
  useState: typeof useState;
  useEffect: typeof useEffect;

  Button: typeof Button;
  Card: typeof Card;
  Alert: typeof Alert;

  Canvas: typeof Canvas;
  OrbitControls: typeof OrbitControls;
};

export function evaluateToComponent(
  compiledJs: string,
): React.ComponentType<any> {
  if (/\bimport\b/.test(compiledJs)) {
    throw new Error("Imports are not supported.");
  }

  const wrapped = `
    "use strict";
    const exports = {};
    const module = { exports };

    const React = scope.React;
    const useState = scope.useState;
    const useEffect = scope.useEffect;

    const Button = scope.Button;
    const Card = scope.Card;
    const Alert = scope.Alert;

    const Canvas = scope.Canvas;
    const OrbitControls = scope.OrbitControls;

    ${compiledJs}

    return module.exports.default || exports.default;
  `;

  const fn = new Function("scope", wrapped);

  const scope: Scope = {
    React: React,
    useState: useState,
    useEffect: useEffect,

    Button: Button,
    Card: Card,
    Alert: Alert,

    Canvas: Canvas,
    OrbitControls: OrbitControls,
  };

  const Component = fn(scope);

  if (typeof Component !== "function") {
    throw new Error("Default export must be a React component.");
  }
  return Component;
}
