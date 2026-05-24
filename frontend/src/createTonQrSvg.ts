const qrVersion = 6;
const qrSize = 17 + qrVersion * 4;
const qrDataCodewords = 136;
const qrBlockDataCodewords = 68;
const qrEccCodewords = 18;
const qrMaxBytes = 134;

type QrMatrix = {
  modules: boolean[][];
  reserved: boolean[][];
};

function createMatrix(): QrMatrix {
  return {
    modules: Array.from({ length: qrSize }, () => Array(qrSize).fill(false)),
    reserved: Array.from({ length: qrSize }, () => Array(qrSize).fill(false))
  };
}

function inBounds(row: number, col: number) {
  return row >= 0 && row < qrSize && col >= 0 && col < qrSize;
}

function setFunction(matrix: QrMatrix, row: number, col: number, dark: boolean) {
  if (!inBounds(row, col)) {
    return;
  }

  matrix.modules[row][col] = dark;
  matrix.reserved[row][col] = true;
}

function drawFinder(matrix: QrMatrix, row: number, col: number) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const currentRow = row + dy;
      const currentCol = col + dx;

      if (!inBounds(currentRow, currentCol)) {
        continue;
      }

      const inFinder = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark = inFinder && (
        dx === 0 ||
        dx === 6 ||
        dy === 0 ||
        dy === 6 ||
        (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)
      );

      setFunction(matrix, currentRow, currentCol, dark);
    }
  }
}

function drawAlignment(matrix: QrMatrix, centerRow: number, centerCol: number) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(
        matrix,
        centerRow + dy,
        centerCol + dx,
        distance === 2 || distance === 0
      );
    }
  }
}

function drawFunctionPatterns(matrix: QrMatrix) {
  drawFinder(matrix, 0, 0);
  drawFinder(matrix, 0, qrSize - 7);
  drawFinder(matrix, qrSize - 7, 0);
  drawAlignment(matrix, 34, 34);

  for (let i = 8; i < qrSize - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunction(matrix, 6, i, dark);
    setFunction(matrix, i, 6, dark);
  }

  setFunction(matrix, qrSize - 8, 8, true);
}

function appendBits(bits: number[], value: number, length: number) {
  for (let i = length - 1; i >= 0; i -= 1) {
    bits.push((value >>> i) & 1);
  }
}

function bytesToCodewords(bytes: Uint8Array) {
  if (bytes.length > qrMaxBytes) {
    return null;
  }

  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) {
    appendBits(bits, byte, 8);
  }

  const remainingBits = qrDataCodewords * 8 - bits.length;
  appendBits(bits, 0, Math.min(4, Math.max(0, remainingBits)));

  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords: number[] = [];
  for (let offset = 0; offset < bits.length; offset += 8) {
    codewords.push(Number.parseInt(bits.slice(offset, offset + 8).join(""), 2));
  }

  const pads = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < qrDataCodewords) {
    codewords.push(pads[padIndex % pads.length]);
    padIndex += 1;
  }

  return codewords;
}

const gfExp = new Array<number>(512);
const gfLog = new Array<number>(256);

function initGaloisTables() {
  let value = 1;

  for (let i = 0; i < 255; i += 1) {
    gfExp[i] = value;
    gfLog[value] = i;
    value <<= 1;
    if (value & 0x100) {
      value ^= 0x11d;
    }
  }

  for (let i = 255; i < 512; i += 1) {
    gfExp[i] = gfExp[i - 255];
  }
}

initGaloisTables();

function gfMultiply(left: number, right: number) {
  if (left === 0 || right === 0) {
    return 0;
  }

  return gfExp[gfLog[left] + gfLog[right]];
}

function reedSolomonGenerator(degree: number) {
  let polynomial = [1];

  for (let i = 0; i < degree; i += 1) {
    const next = new Array(polynomial.length + 1).fill(0);
    for (let j = 0; j < polynomial.length; j += 1) {
      next[j] ^= polynomial[j];
      next[j + 1] ^= gfMultiply(polynomial[j], gfExp[i]);
    }
    polynomial = next;
  }

  return polynomial;
}

const rsGenerator = reedSolomonGenerator(qrEccCodewords);

function reedSolomonRemainder(data: number[]) {
  const result = new Array(qrEccCodewords).fill(0);

  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);

    for (let i = 0; i < qrEccCodewords; i += 1) {
      result[i] ^= gfMultiply(rsGenerator[i + 1], factor);
    }
  }

  return result;
}

function buildFinalCodewords(codewords: number[]) {
  const blocks = [
    codewords.slice(0, qrBlockDataCodewords),
    codewords.slice(qrBlockDataCodewords, qrBlockDataCodewords * 2)
  ];
  const eccBlocks = blocks.map(reedSolomonRemainder);
  const finalCodewords: number[] = [];

  for (let i = 0; i < qrBlockDataCodewords; i += 1) {
    for (const block of blocks) {
      finalCodewords.push(block[i]);
    }
  }

  for (let i = 0; i < qrEccCodewords; i += 1) {
    for (const block of eccBlocks) {
      finalCodewords.push(block[i]);
    }
  }

  return finalCodewords;
}

function formatBits(mask: number) {
  const data = (0b01 << 3) | mask;
  let remainder = data << 10;

  for (let i = 14; i >= 10; i -= 1) {
    if (((remainder >>> i) & 1) !== 0) {
      remainder ^= 0x537 << (i - 10);
    }
  }

  return ((data << 10) | remainder) ^ 0x5412;
}

function bitAt(value: number, index: number) {
  return ((value >>> index) & 1) !== 0;
}

function drawFormatBits(matrix: QrMatrix, mask: number) {
  const bits = formatBits(mask);

  for (let i = 0; i < 15; i += 1) {
    const dark = bitAt(bits, i);

    if (i < 6) {
      setFunction(matrix, i, 8, dark);
    } else if (i < 8) {
      setFunction(matrix, i + 1, 8, dark);
    } else {
      setFunction(matrix, qrSize - 15 + i, 8, dark);
    }

    if (i < 8) {
      setFunction(matrix, 8, qrSize - i - 1, dark);
    } else if (i < 9) {
      setFunction(matrix, 8, 15 - i, dark);
    } else {
      setFunction(matrix, 8, 14 - i, dark);
    }
  }

  setFunction(matrix, qrSize - 8, 8, true);
}

function maskData(row: number, col: number, mask: number) {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function drawData(matrix: QrMatrix, finalCodewords: number[], mask: number) {
  const bits = finalCodewords.flatMap((byte) =>
    Array.from({ length: 8 }, (_, index) => (byte >>> (7 - index)) & 1)
  );
  let bitIndex = 0;
  let upward = true;

  for (let rightCol = qrSize - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) {
      rightCol -= 1;
    }

    for (let vertical = 0; vertical < qrSize; vertical += 1) {
      const row = upward ? qrSize - 1 - vertical : vertical;

      for (let colOffset = 0; colOffset < 2; colOffset += 1) {
        const col = rightCol - colOffset;

        if (matrix.reserved[row][col]) {
          continue;
        }

        const rawBit = bitIndex >= bits.length ? false : bits[bitIndex] === 1;
        const maskBit = maskData(row, col, mask);
        matrix.modules[row][col] = rawBit !== maskBit;
        if (bitIndex < bits.length) {
          bitIndex += 1;
        }
      }
    }

    upward = !upward;
  }
}

function getPenaltyLine(line: boolean[]) {
  let penalty = 0;
  let runColor = line[0];
  let runLength = 1;

  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === runColor) {
      runLength += 1;
      continue;
    }

    if (runLength >= 5) {
      penalty += 3 + runLength - 5;
    }
    runColor = line[i];
    runLength = 1;
  }

  if (runLength >= 5) {
    penalty += 3 + runLength - 5;
  }

  return penalty;
}

function hasFinderLikePattern(line: boolean[], offset: number) {
  const pattern = [true, false, true, true, true, false, true];
  for (let i = 0; i < pattern.length; i += 1) {
    if (line[offset + i] !== pattern[i]) {
      return false;
    }
  }

  const leftLight =
    offset >= 4 &&
    !line[offset - 1] &&
    !line[offset - 2] &&
    !line[offset - 3] &&
    !line[offset - 4];
  const rightLight =
    offset + 11 <= line.length &&
    !line[offset + 7] &&
    !line[offset + 8] &&
    !line[offset + 9] &&
    !line[offset + 10];

  return leftLight || rightLight;
}

function scoreMatrix(matrix: QrMatrix) {
  let penalty = 0;
  let darkModules = 0;

  for (let row = 0; row < qrSize; row += 1) {
    penalty += getPenaltyLine(matrix.modules[row]);
    for (let col = 0; col < qrSize; col += 1) {
      if (matrix.modules[row][col]) {
        darkModules += 1;
      }
    }
  }

  for (let col = 0; col < qrSize; col += 1) {
    const column = matrix.modules.map((row) => row[col]);
    penalty += getPenaltyLine(column);
  }

  for (let row = 0; row < qrSize - 1; row += 1) {
    for (let col = 0; col < qrSize - 1; col += 1) {
      const color = matrix.modules[row][col];
      if (
        matrix.modules[row][col + 1] === color &&
        matrix.modules[row + 1][col] === color &&
        matrix.modules[row + 1][col + 1] === color
      ) {
        penalty += 3;
      }
    }
  }

  for (let row = 0; row < qrSize; row += 1) {
    for (let col = 0; col <= qrSize - 7; col += 1) {
      if (hasFinderLikePattern(matrix.modules[row], col)) {
        penalty += 40;
      }
    }
  }

  for (let col = 0; col < qrSize; col += 1) {
    const column = matrix.modules.map((row) => row[col]);
    for (let row = 0; row <= qrSize - 7; row += 1) {
      if (hasFinderLikePattern(column, row)) {
        penalty += 40;
      }
    }
  }

  const darkPercent = (darkModules * 100) / (qrSize * qrSize);
  penalty += Math.floor(Math.abs(darkPercent - 50) / 5) * 10;

  return penalty;
}

function buildMatrix(finalCodewords: number[], mask: number) {
  const matrix = createMatrix();
  drawFunctionPatterns(matrix);
  drawFormatBits(matrix, mask);
  drawData(matrix, finalCodewords, mask);
  return matrix;
}

function isFinderModule(row: number, col: number) {
  return (
    (row < 7 && col < 7) ||
    (row < 7 && col >= qrSize - 7) ||
    (row >= qrSize - 7 && col < 7)
  );
}

type TonQrTone = "dark-on-light" | "light-on-dark";

export function createTonQrSvg(payload: string, tone: TonQrTone = "dark-on-light") {
  const bytes = new TextEncoder().encode(payload);
  const dataCodewords = bytesToCodewords(bytes);

  if (!dataCodewords) {
    return null;
  }

  const finalCodewords = buildFinalCodewords(dataCodewords);
  let matrix = buildMatrix(finalCodewords, 0);
  let bestPenalty = scoreMatrix(matrix);

  for (let mask = 1; mask < 8; mask += 1) {
    const candidate = buildMatrix(finalCodewords, mask);
    const penalty = scoreMatrix(candidate);
    if (penalty < bestPenalty) {
      matrix = candidate;
      bestPenalty = penalty;
    }
  }

  const margin = 4;
  const viewSize = qrSize + margin * 2;
  const toneClass = tone === "light-on-dark"
    ? "tonhub-qr-svg--light-on-dark"
    : "tonhub-qr-svg--dark-on-light";
  const dataDots = matrix.modules
    .flatMap((row, rowIndex) =>
      row.map((dark, colIndex) =>
        dark && !isFinderModule(rowIndex, colIndex)
          ? `<circle cx="${colIndex + margin + 0.5}" cy="${rowIndex + margin + 0.5}" r="0.34"/>`
          : ""
      )
    )
    .filter(Boolean)
    .join("");
  const finders = [
    [margin, margin],
    [qrSize + margin - 7, margin],
    [margin, qrSize + margin - 7]
  ]
    .map(([x, y]) =>
      [
        `<g>`,
        `<rect x="${x}" y="${y}" width="7" height="7" rx="1.2" ry="1.2"/>`,
        `<rect x="${x + 1}" y="${y + 1}" width="5" height="5" rx="0.8" ry="0.8" class="tonhub-qr-bg-fill"/>`,
        `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="0.35" ry="0.35"/>`,
        `</g>`
      ].join("")
    )
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" role="img" aria-label="TON payment QR" class="tonhub-qr-svg ${toneClass}">`,
    `<rect width="${viewSize}" height="${viewSize}" rx="2.2" ry="2.2" class="tonhub-qr-bg-fill"/>`,
    `<g class="tonhub-qr-fg-fill">${finders}${dataDots}</g>`,
    "</svg>"
  ].join("");
}
