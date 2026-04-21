/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Scene } from './Scene';
import { Editor } from './Editor';

export default function App() {
  return (
    <div className="w-full h-screen bg-black select-none">
      <Editor />
    </div>
  );
}
