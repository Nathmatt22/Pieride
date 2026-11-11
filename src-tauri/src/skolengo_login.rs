//! Connexion à Skolengo par la page de l'ENT, dans une fenêtre à part. La page commence par
//! l'adresse OIDC calculée par `skolengojs` (défi PKCE) et se termine par un retour vers
//! `skoapp-prod://sign-in-callback`, l'adresse enregistrée par l'application mobile Skolengo.
//! Rust intercepte ce retour : le code et son état reviennent à la WebView, sans jamais lire
//! le mot de passe. La fenêtre est privée et n'a accès à aucune commande de l'app.

use serde_json::{Value, json};
use tauri::{
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, async_runtime,
    webview::NewWindowResponse,
};

use crate::instance_origin;

const LABEL: &str = "skolengo-login";
/// Le schéma du retour OIDC, celui de l'application mobile Skolengo.
const RETURN_SCHEME: &str = "skoapp-prod";
const RETURN_HOST: &str = "sign-in-callback";

type Result<T> = std::result::Result<T, &'static str>;

/// Ouvre la page de connexion et attend : `{ code, state }`, `{ error }` si l'ENT a refusé, ou
/// `null` si la fenêtre est fermée avant. `url` est l'adresse OIDC de `skolengojs`, `title` le
/// titre traduit. Les erreurs sont des codes : `invalid_url`, `invalid_title`, `login_open`
/// (une connexion est déjà ouverte) ou `login_window`.
#[tauri::command]
pub async fn skolengo_login(app: AppHandle, url: String, title: String) -> Result<Option<Value>> {
    instance_origin(&url)?;
    let target = Url::parse(&url).map_err(|_| "invalid_url")?;
    if title.is_empty() || title.chars().count() > 100 {
        return Err("invalid_title");
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return Err("login_open");
    }

    // Le premier résultat gagne : le retour OIDC, ou `None` à la fermeture de la fenêtre.
    let (sender, mut receiver) = async_runtime::channel(1);
    let on_return = sender.clone();
    let handle = app.clone();
    let popup = app.clone();
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(target))
        .title(title)
        .inner_size(480.0, 720.0)
        .center()
        .incognito(true)
        .on_navigation(move |target| {
            if target.scheme() != RETURN_SCHEME || target.host_str() != Some(RETURN_HOST) {
                return true;
            }
            if let Some(found) = callback(target) {
                let _ = on_return.try_send(Some(found));
                with_window(&handle, |window| {
                    let _ = window.close();
                });
            }
            false
        })
        // Un ENT qui ouvre une fenêtre : la page s'ouvre à la place, comme pour PRONOTE.
        .on_new_window(move |target, _features| {
            if matches!(target.scheme(), "https" | "http") {
                with_window(&popup, move |window| {
                    let _ = window.navigate(target);
                });
            }
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|_| "login_window")?;
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = sender.try_send(None);
        }
    });
    Ok(receiver.recv().await.flatten())
}

/// Agit sur la fenêtre hors du gestionnaire en cours, qui tourne sur le fil de l'interface.
fn with_window(app: &AppHandle, action: impl FnOnce(tauri::WebviewWindow) + Send + 'static) {
    if let Some(window) = app.get_webview_window(LABEL) {
        async_runtime::spawn(async move { action(window) });
    }
}

/// Le code et l'état du retour OIDC, ou l'erreur envoyée par l'ENT.
fn callback(url: &Url) -> Option<Value> {
    let (mut code, mut state, mut error) = (None, None, None);
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }
    if let Some(error) = error {
        return plausible(&error).then(|| json!({ "error": error }));
    }
    let (code, state) = (code?, state?);
    (plausible(&code) && plausible(&state)).then(|| json!({ "code": code, "state": state }))
}

fn plausible(text: &str) -> bool {
    (1..=4096).contains(&text.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(url: &str) -> Option<Value> {
        callback(&Url::parse(url).unwrap())
    }

    #[test]
    fn lit_le_code_et_l_etat() {
        assert_eq!(
            read("skoapp-prod://sign-in-callback?code=abc%2B1&state=xyz"),
            Some(json!({ "code": "abc+1", "state": "xyz" }))
        );
    }

    #[test]
    fn transmet_le_refus_de_l_ent() {
        assert_eq!(
            read("skoapp-prod://sign-in-callback?error=access_denied"),
            Some(json!({ "error": "access_denied" }))
        );
    }

    #[test]
    fn ignore_un_retour_incomplet() {
        assert_eq!(read("skoapp-prod://sign-in-callback?code=abc"), None);
        assert_eq!(read("skoapp-prod://sign-in-callback?code=&state=x"), None);
        let long = "x".repeat(4097);
        assert_eq!(
            read(&format!(
                "skoapp-prod://sign-in-callback?code={long}&state=x"
            )),
            None
        );
    }
}
