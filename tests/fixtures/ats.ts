export function atsFixture(ats: string, multipage = false) {
  return `<!doctype html><html><body data-ats="${ats}" class="${ats}"><h1>${ats} application</h1><form id="application" action="/application/submit"><section id="contact"><h2>Contact</h2><label>First name<input name="first" required></label><label>Last name<input name="last" required></label><label>Email<input name="email" type="email" required></label><label>Phone<input name="phone" required></label><label>Resume<input type="file" required></label><label>Are you legally authorized to work in the United States?<select required><option value="">Select</option><option>Yes</option><option>No</option></select></label></section><section id="review" ${multipage ? "hidden" : ""}><h2>Review</h2><button type="submit">Submit Application</button></section></form>${multipage ? '<button type="button" id="next">Save and Continue</button>' : ""}<script>window.finalSubmissions=0;document.getElementById('application').addEventListener('submit',e=>{e.preventDefault();window.finalSubmissions++});document.getElementById('next')?.addEventListener('click',()=>{document.getElementById('contact').hidden=true;document.getElementById('next').hidden=true;document.getElementById('review').hidden=false});</script></body></html>`;
}

export function hydratedAshbyFixture(
  requiredUnknown = false,
  clearKnownEmailOnce = false,
) {
  const unknown = `<div data-field-path="unknown"><label for="unknown">Optional demographic detail</label><input id="unknown"></div>`;
  return `<!doctype html><html><body class="ashby"><h1>Ashby application</h1><div id="loader">Fetching application form</div><main id="root"></main><script>
  window.finalSubmissions=0;
  const yesno=(id,q)=>\`<div data-field-path="\${id}"><label class="required" data-required="true">\${q} *</label><div><button type="button" aria-pressed="false" data-option="yes">Yes</button><button type="button" aria-pressed="false" data-option="no">No</button><input style="display:none" type="checkbox" name="\${id}"></div></div>\`;
  const radios=(id,q,values,required=true)=>\`<fieldset><label class="\${required?'required':''}" data-required="\${required}">\${q}\${required?' *':''}</label>\${values.map((v,i)=>\`<label>\${v}<input id="\${id}-\${i}" type="radio" name="\${id}"></label>\`).join('')}</fieldset>\`;
  const checks=(id,q,values,required=false)=>\`<fieldset><label class="\${required?'required':''}" data-required="\${required}">\${q}\${required?' *':''}</label>\${values.map((v,i)=>\`<label>\${v}<input id="\${id}-\${i}" type="checkbox" name="\${v}"></label>\`).join('')}</fieldset>\`;
  setTimeout(()=>{document.getElementById('loader').remove();document.getElementById('root').innerHTML=\`<form id="application" action="/application/submit">
    <div data-field-path="name"><label for="name">Legal Full Name *</label><input id="name" required></div>
    <div data-field-path="preferred"><label for="preferred">Preferred First Name</label><input id="preferred"></div>
    <label>Email<input type="email" required></label><label>Phone<input type="tel" required></label>
    <label>Resume<input type="file" required></label><label>LinkedIn URL<input type="url" required></label>
    <label>How did you hear about this job?<select required><option value="">Select</option><option>Company website</option><option>LinkedIn Job Posting</option><option>Other</option></select></label>
    <div data-field-path="location"><label class="required" for="missing-location-id">Location *</label><input role="combobox" aria-expanded="false" required><div role="listbox" hidden><div role="option">Beaverton, Oregon, United States</div><div role="option">Beaverton, Alabama, United States</div></div></div>
    \${yesno('authorized','Are you authorized to be employed in the United States?')}
    \${yesno('sponsorship','Do you need visa sponsorship?')}
    \${yesno('student','Have you recently graduated, or are you currently attending, a college or university in the US or Canada?')}
    \${yesno('csdegree','Have you received, or are you currently pursuing, a degree in computer science or a related field?')}
    \${radios('degree','Which degree are you currently pursuing?',['Bachelors','Masters','PhD'])}
    \${radios('graduation','When is your expected graduation date?',['2025','2026','January - June 2027'])}
    \${yesno('hub','Do you currently live within 50 miles of one of our hubs in San Francisco or Seattle?')}
    \${yesno('relocation','Are you willing to relocate?')}
    \${radios('veteran','Are you a veteran or active member of the United States Armed Forces?',['Yes, I am a veteran or active member','No, I am not a veteran or active member',"I don't wish to answer"],false)}
    \${radios('disability','Do you have a disability or chronic condition?',['Yes','No',"I don't wish to answer"],false)}
    \${checks('race','How would you describe your racial/ethnic background? (mark all that apply)',['South Asian','East Asian','Southeast Asian',"I don't wish to answer"],${requiredUnknown})}
    \${radios('transgender','Do you identify as transgender?',['Yes','No',"I don't wish to answer"],false)}
    \${checks('gender','How would you describe your gender identity? (mark all that apply)',['Man','Woman','Non-binary',"I don't wish to answer"])}
    \${checks('orientation','How would you describe your sexual orientation? (mark all that apply)',['Heterosexual','Gay','Asexual',"I don't wish to answer"])}
    ${unknown}<button type="submit">Submit Application</button></form>\`;
    document.querySelectorAll('button[data-option]').forEach(button=>button.addEventListener('click',()=>{button.parentElement.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed','false'));button.setAttribute('aria-pressed','true')}));
    const location=document.querySelector('[data-field-path="location"] input');const list=location.nextElementSibling;location.addEventListener('input',()=>{location.setAttribute('aria-expanded','true');list.hidden=false});list.querySelectorAll('[role=option]').forEach(option=>option.addEventListener('click',()=>{location.value=option.textContent;location.setAttribute('aria-expanded','false');location.dataset.selected='true';list.hidden=true}));
    if (${clearKnownEmailOnce}) { const email=document.querySelector('input[type=email]');let attempts=0;email.addEventListener('input',()=>{attempts++;if(attempts===1)email.value=''}) }
    document.getElementById('application').addEventListener('submit',event=>{event.preventDefault();window.finalSubmissions++});
  },150);
  </script></body></html>`;
}
