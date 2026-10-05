function chain() {
  const value = {
    pattern() { return value; },
    default() { return value; },
    volatile() { return value; },
    step() { return value; },
    min() { return value; },
    max() { return value; },
  };
  return value;
}

export default {
  object() { return chain(); },
  string() { return chain(); },
  number() { return chain(); },
  boolean() { return chain(); },
  array() { return chain(); },
  const() { return chain(); },
  union() { return chain(); },
};
