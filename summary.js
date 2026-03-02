////Version 3 on 13 Feb 2026, 20:04
//https://script.google.com/macros/s/AKfycbze-wn6RmNbUShu6NQQbNz8N9NnjVFMxeqx7WBpwPKY50JXun-9nj2EhbgzefA7U4tEOg/exec

/****************************************************
 * CAPIL HADIR – REKAP SUMMARY v1.0 (FINAL)
 ****************************************************/
const SPREADSHEET_ID = '11lU4f6s5cMBMMEIftwr1B0mRQO4s8RFQ4kw82rWm1AI';
const TZ = 'Asia/Makassar';

function doGet(e){
  try{
    const p = e.parameter || {};
    const api = String(p.api||'').toLowerCase();

    if(api === 'summary'){
      const year  = parseInt(p.year,10);
      const month = parseInt(p.month,10);
      const statusFilter = String(p.status||'ALL').toUpperCase();
      
      if(!Number.isFinite(year) || !Number.isFinite(month) || month<1 || month>12){
        return json_({ok:false,message:'Param wajib: year, month(1..12)'});
      }
      return json_(apiSummary_(year, month, statusFilter));
    }

    return json_({ok:false,message:'Route not found'});
  }catch(err){
    return json_({ok:false,message:'Error: '+err.message});
  }
}


function apiSummary_(year, month, statusFilter){
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const shPeg = ss.getSheetByName('Pegawai');
  const shAbs = ss.getSheetByName('Absensi');
  const shIzn = ss.getSheetByName('Izin');
  const shApl = ss.getSheetByName('Absen_Apel');
  const shLib = ss.getSheetByName('Libur');

  if(!shPeg || !shAbs) 
    return {ok:false,message:'Sheet wajib tidak ditemukan'};

  const m0 = month-1;
  const start = new Date(year,m0,1);
  const end   = new Date(year,m0+1,1);
  const totalDays = new Date(year,month,0).getDate();

  // ===== Batasi sampai hari ini =====
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth()+1;

  let days = totalDays;
  if(year > currentYear || (year===currentYear && month>currentMonth)){
    days = 0;
  }else if(year===currentYear && month===currentMonth){
    days = today.getDate();
  }

  // ===== LIBUR NASIONAL =====
  const liburSet = new Set();
  if(shLib){
    shLib.getDataRange().getValues().slice(1).forEach(r=>{
      liburSet.add(fmt_(r[0],'dd/MM/yyyy'));
    });
  }

// ===== PEGAWAI =====
const pegMap = {};
shPeg.getDataRange().getValues().slice(1)
  .filter(r=>String(r[0]||'').trim())
  .forEach(r=>{
    const nip = String(r[0]).trim();
    const nama = String(r[1]||'').trim();
    const statusPeg = String(r[5]||'').toUpperCase(); // ⬅️ kolom F

    const wk = String(r[6]||'').toUpperCase(); // kolom G (Waktu Kerja)

    let pola = 'FULL';
    if(wk.includes('GANJIL')) pola='GANJIL';
    else if(wk.includes('GENAP')) pola='GENAP';

    pegMap[nip]={
      nip,
      nama,
      pola,
      status: statusPeg
    };
  });


  // ===== APEL =====
  const apelMap={};
  if(shApl){
    shApl.getDataRange().getValues().slice(1).forEach(r=>{
      const nip=String(r[1]||'').trim();
      if(!pegMap[nip]) return;
      const t=fmt_(r[0],'dd/MM/yyyy');
      if(!apelMap[nip]) apelMap[nip]=new Set();
      apelMap[nip].add(t);
    });
  }

  // ===== ABSENSI =====
  const absMap={};
  shAbs.getDataRange().getValues().slice(1)
    .filter(r=>new Date(r[0])>=start && new Date(r[0])<end)
    .forEach(r=>{
      const nip=String(r[1]||'').trim();
      if(!pegMap[nip]) return;
      const t=fmt_(r[0],'dd/MM/yyyy');

      const masuk=r[3], siang=r[4], pulang=r[5];
      const status=String(r[6]||'').toUpperCase();

      const hadir=!!(masuk||siang||pulang)||status==='PULANG CEPAT';

      if(!absMap[nip]) absMap[nip]={};
      absMap[nip][t]={hadir};
    });

  // ===== IZIN =====
  const izinMap={};
  if(shIzn){
    shIzn.getDataRange().getValues().slice(1)
      .filter(r=>String(r[8]||'').toUpperCase()==='DISETUJUI')
      .forEach(r=>{
        const nip=String(r[2]||'').trim();
        if(!pegMap[nip]) return;
        const t=fmt_(r[1],'dd/MM/yyyy');
        const jenis=String(r[5]||'').toUpperCase();

        if(!izinMap[nip]) izinMap[nip]={};
        if(!izinMap[nip][t]) izinMap[nip][t]={};

        if(jenis==='SAKIT') izinMap[nip][t].sakit=true;
        else if(jenis==='PULANG CEPAT') izinMap[nip][t].hadir=true;
        else izinMap[nip][t].izin=true;
      });
  }

  // ===== HITUNG =====
  const rows=[];
  let no=1;

  Object.keys(pegMap).sort().forEach(nip=>{

  if(statusFilter !== 'ALL' && pegMap[nip].status !== statusFilter){
    return;
  }
    let APEL=0,HADIR=0,IZIN=0,SAKIT=0;

    for(let d=1; d<=days; d++){
      const dt=new Date(year,m0,d);
      const day=dt.getDay();
      const tanggalNum=dt.getDate();
      const t=fmt_(dt,'dd/MM/yyyy');

      const isWeekend=(day===0||day===6);
      const isWajibMasuk=(day===1||day===5);

      let bukanJadwal=false;

      if(!isWajibMasuk){
        if(pegMap[nip].pola==='GANJIL' && tanggalNum%2===0) bukanJadwal=true;
        if(pegMap[nip].pola==='GENAP' && tanggalNum%2!==0) bukanJadwal=true;
      }

      if(isWeekend || liburSet.has(t) || bukanJadwal) continue;

      if(apelMap[nip]?.has(t)) APEL++;

      const a=absMap[nip]?.[t]||{};
      const i=izinMap[nip]?.[t]||{};

      if(a.hadir||i.hadir){
        HADIR++;
      }else if(i.sakit){
        SAKIT++;
      }else if(i.izin){
        IZIN++;
      }
    }

    rows.push({
      NO:no++,
      NIP:nip,
      NAMA:pegMap[nip].nama,
      STATUS: pegMap[nip].status, // ⬅️ tambahkan
      APEL,
      HADIR,
      IZIN,
      SAKIT
    });
  });

  return {
    ok:true,
    meta:{year,month,bulanNama:bulan_(month),totalPegawai:rows.length},
    rows
  };
}

/* ===== Helpers ===== */

function json_(o){return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);}
function fmt_(d,p){return Utilities.formatDate(new Date(d),TZ,p);}
function bulan_(m){return['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'][m-1]||m;}
