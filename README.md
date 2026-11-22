# VoxBox

Changeur de voix et banque de sons pour **Windows**, 100 % local : tout le traitement de la voix (effets, voix IA) tourne sur le PC. La seule partie qui utilise Internet est l'onglet « Explorer MyInstants » de la banque de sons ; chaque son ajouté est téléchargé et fonctionne ensuite hors ligne.

- 22 voix prêtes à l'emploi (Villageois, Robot, Démon, Chipmunk, Géant, Radio, Cathédrale, Alien...) et un éditeur pour créer les siennes à partir de 18 effets.
- Voix IA RVC (ONNX Runtime + DirectML : cartes NVIDIA et AMD), import de modèles `.pth` + `.index` avec conversion intégrée, 2 voix fournies.
- Banque de sons : glisser-déposer mp3/wav/ogg/flac, catégories, favoris, volume, boucle, recherche MyInstants façon Giphy. Les sons partent dans le micro **et** dans le casque, avec un volume pour chaque côté.
- Raccourcis globaux (actifs en jeu) : changer de voix, activer ou couper la voix, push-to-talk maintenu, sons, M'entendre. Les boutons latéraux de souris sont pris en charge.
- Anti-bruit (RNNoise), « M'entendre », démarrage réduit, icône dans la zone de notification.

## Installation (utilisateur)

1. Lancer `VoxBox_x.y.z_x64-setup.exe` (artefact `voxbox-installer` de la CI Windows). L'installeur propose d'installer **VB-CABLE**, qui crée le micro virtuel. Redémarrer ensuite le PC.
2. Optionnel : lancer `VoxBox-Voix-IA-setup.exe` (artefact `voxbox-ai-pack` du workflow « AI voices pack ») pour ajouter les voix IA.
3. Dans Discord, OBS ou le jeu, choisir **« CABLE Output (VB-Audio Virtual Cable) »** comme micro.
4. Dans VoxBox → Réglages, vérifier le micro réel et le casque.

## Architecture

```
crates/voxbox-dsp         effets temps réel, 22 voix, catalogue des effets (Rust pur)
crates/voxbox-engine      moteur audio : WASAPI (cpal), anti-bruit, PTT, mixeur, sorties CABLE + casque
crates/voxbox-rvc         voix IA RVC v2 en streaming (ONNX Runtime chargé dynamiquement)
crates/voxbox-myinstants  recherche / téléchargement MyInstants (analyse HTML, pas d'API officielle)
src-tauri                 app Tauri 2 : commandes, stockage JSON, raccourcis globaux (hooks bas niveau), tray
ui                        interface React (pixel art), mock intégré pour le navigateur
converter                 conversion .pth → ONNX, runtime Python embarqué (pack Voix IA)
installer, scripts        hooks NSIS (VB-CABLE), pack Voix IA, icônes
```

Le contrat entre l'interface et Rust est dans `ui/src/ipc/contract.ts`. Les voix et le catalogue utilisés par le mock de l'interface sont générés depuis Rust (`cargo run -p voxbox-dsp --example dump_presets -- ui/src/ipc/generated`), et un test échoue s'ils divergent.

## Développement

```bash
cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
pnpm --dir ui install && pnpm --dir ui test && pnpm --dir ui dev   # UI seule : http://localhost:1420 (backend simulé)
cd src-tauri && npx @tauri-apps/cli@2 dev                         # app complète (Windows)
python scripts/fetch_vbcable.py && cd src-tauri && npx @tauri-apps/cli@2 build   # installeur
```

L'interface accepte des paramètres d'URL dans le navigateur : `?screen=voices|sounds|editor|ai|settings`, `?offline`, `?nocable`.
Pour écouter une voix sans lancer l'app : `cargo run -p voxbox-dsp --example render -- villager in.wav out.wav`.

## Licences et attributions

- **VB-CABLE** est un donationware de VB-Audio (www.vb-cable.com), toutes les participations sont les bienvenues. Le pack officiel est redistribué tel quel et installé par son propre setup, comme le permet https://vb-audio.com/Services/licensing.htm. **En entreprise, quand les employés ne peuvent ni identifier VB-CABLE ni le financer, il faut acheter des licences VB-CABLE** ; un usage interne n'en dispense pas.
- **MyInstants** n'a pas d'API officielle : l'app lit les pages publiques du site, ce qui peut casser si le site change. L'analyse est isolée dans `crates/voxbox-myinstants/src/parser.rs` et testée sur des pages enregistrées. Les droits des sons restent ceux de leurs auteurs.
- **Voix IA fournies** : modèles RVC VCTK p231 et p226 de Nekochu (Apache-2.0), entraînés sur le corpus CSTR VCTK (CC BY 4.0, Yamagishi, Veaux, MacDonald, University of Edinburgh). ContentVec (MIT) et RMVPE (Apache-2.0) : voir `converter/assets.json` et `converter/licenses/`. ONNX Runtime (MIT) et DirectML (licence redistribuable Microsoft) sont copiés avec leurs licences dans le pack.

## Limites connues (V1)

- Le code a été développé et testé sous Linux, sans carte son ni GPU. La CI Windows compile l'app, lance les tests et produit l'installeur, mais **le rendu audio réel, la latence micro → Discord, VB-CABLE et les voix IA sur GPU restent à vérifier sur un vrai PC** (voir la checklist ci-dessous).
- Latence visée pour les effets : environ 22 à 27 ms de tampons, plus la latence propre à chaque voix (hauteur + formants ≈ 50 ms). Voix IA : environ 150 à 300 ms, selon la carte et la taille de bloc choisie.
- Les jeux protégés par un anti-triche peuvent bloquer les hooks clavier (raccourcis globaux).
- Les voix IA fournies sont des voix anglaises : en français, elles gardent le timbre mais pas l'accent.

## Checklist de test sur un PC Windows

1. Installer, redémarrer, puis vérifier que « CABLE Output » apparaît comme micro dans Discord.
2. Voix Villageois active : parler, puis vérifier dans Discord (bouton « Vérifier le micro ») que la voix est transformée et sans craquements.
3. Activer « M'entendre » avec un casque : la voix modifiée doit s'entendre, avec un retard acceptable.
4. Raccourcis : Ctrl+Alt+1..9 en jeu, Ctrl+Alt+V pour couper la voix, push-to-talk maintenu.
5. Sons : glisser un mp3, le jouer (il doit s'entendre dans Discord et dans le casque), tester boucle et stop. Ajouter un son depuis MyInstants.
6. Débrancher puis rebrancher le casque : un message s'affiche, puis l'app repart après avoir resélectionné le casque dans Réglages.
7. Pack Voix IA : voix « VCTK p231 », vérifier le backend affiché (DirectML) et la latence, puis importer un `.pth`.
