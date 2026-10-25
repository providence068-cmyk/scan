// カメラの映像から紙の四隅を探す作業スレッド（画面の動きを止めないため）
importScripts('detector.js');
onmessage = e => {
  let r = null;
  try{ r = DocDetect.detect(e.data.img, e.data.prev, { trackOk: 0.4, minScore: 0.15 }); }catch(err){}
  postMessage(r);
};
