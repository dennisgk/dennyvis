import React, { useEffect, useState, useRef, useMemo } from "react";
import * as Babel from "@babel/standalone";

import {
  Button,
  Card,
  Alert,
  Table,
  Image,
  Accordion,
  Dropdown,
  Modal,
  ProgressBar,
  Spinner,
  Tabs,
  Tab,
} from "react-bootstrap";
import { Canvas, useFrame } from "@react-three/fiber";
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
  useRef: typeof useRef;
  useMemo: typeof useMemo;
  useFrame: typeof useFrame;

  Button: typeof Button;
  Card: typeof Card;
  Alert: typeof Alert;
  Table: typeof Table;
  Image: typeof Image;
  Accordion: typeof Accordion;
  Dropdown: typeof Dropdown;
  Modal: typeof Modal;
  ProgressBar: typeof ProgressBar;
  Spinner: typeof Spinner;
  Tabs: typeof Tabs;
  Tab: typeof Tab;

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
    const useRef = scope.useRef;
    const useMemo = scope.useMemo;
    const useFrame = scope.useFrame;

    const Button = scope.Button;
    const Card = scope.Card;
    const Alert = scope.Alert;
    const Table = scope.Table;
    const Image = scope.Image;
    const Accordion = scope.Accordion;
    const Dropdown = scope.Dropdown;
    const Modal = scope.Modal;
    const ProgressBar = scope.ProgressBar;
    const Spinner = scope.Spinner;
    const Tabs = scope.Tabs;
    const Tab = scope.Tab;

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
    useRef: useRef,
    useMemo: useMemo,
    useFrame: useFrame,

    Button: Button,
    Card: Card,
    Alert: Alert,
    Table: Table,
    Image: Image,
    Accordion: Accordion,
    Dropdown: Dropdown,
    Modal: Modal,
    ProgressBar: ProgressBar,
    Spinner: Spinner,
    Tabs: Tabs,
    Tab: Tab,

    Canvas: Canvas,
    OrbitControls: OrbitControls,
  };

  const Component = fn(scope);

  if (typeof Component !== "function") {
    throw new Error("Default export must be a React component.");
  }
  return Component;
}
