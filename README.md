# VoxBox

Changeur de voix et banque de sons pour **Windows**, 100 % local : tout le traitement de la voix (effets, voix IA) tourne sur le PC. Seuls l'onglet « MyInstants » de l'écran Sons, l'explorateur voice-models.com de l'import de voix IA et la recherche de mises à jour (releases GitHub, au lancement puis toutes les 6 h) utilisent Internet ; chaque son ou modèle ajouté est téléchargé et fonctionne ensuite hors ligne.

- Trois écrans : **Voix**, **Sons**, **Réglages**. 22 voix prêtes à l'emploi (Villageois, Robot, Démon, Chipmunk, Géant, Radio, Cathédrale, Alien...) ; un panneau latéral de l'écran Voix sert à créer, dupliquer ou modifier ses voix à partir de 18 effets.
- Voix IA RVC (ONNX Runtime + DirectML : cartes NVIDIA et AMD), import de modèles `.pth` + `.index` avec conversion intégrée (filtre IA de l'écran Voix), recherche et ajout en un clic depuis voice-models.com, 2 voix fournies.
- Banque de sons : glisser-déposer mp3/wav/ogg/flac, catégories, favoris, volume, boucle, recherche MyInstants façon Giphy. Les sons partent dans le micro **et** dans le casque, avec un volume pour chaque côté.
- Raccourcis globaux (actifs en jeu) : changer de voix, activer ou couper la voix, push-to-talk maintenu, sons, M'entendre. Les boutons latéraux de souris sont pris en charge.
- Anti-bruit (RNNoise), « M'entendre », démarrage réduit, icône dans la zone de notification.

## Installation (utilisateur)

1. Télécharger `VoxBox_x.y.z_x64-setup.exe` dans la dernière release du dépôt (onglet **Releases** : une nouvelle version est publiée à chaque merge sur `main` ; seule exception, si un merge plus récent modifie les workflows pendant le build d'un merge, celui-ci est publié dans la release du suivant), puis le lancer. L'installeur propose d'installer **VB-CABLE**, qui crée le micro virtuel. Redémarrer ensuite le PC.
2. Optionnel : télécharger `VoxBox-Voix-IA-setup.exe` dans la release **« VoxBox - Voix IA N »** au numéro le plus élevé, et le lancer pour ajouter les voix IA. Une nouvelle release du pack est publiée quand il change (ou via le workflow « AI voices pack » lancé à la main).
3. Dans Discord, OBS ou le jeu, choisir **« CABLE Output (VB-Audio Virtual Cable) »** comme micro.
4. Dans VoxBox → Réglages, vérifier le micro réel et le casque.

**Mettre à jour** : VoxBox vérifie au lancement puis toutes les 6 h s'il existe une release plus récente. Une pop-up la propose (une seule fois par version, puis une bannière en haut de l'app) ; « Mettre à jour » télécharge l'installeur, vérifie sa signature, l'installe et relance VoxBox tout seul. Windows demande une autorisation (« Oui ») pendant l'installation, car VoxBox est installé dans *Program Files*. VB-CABLE n'est jamais reproposé lors d'une mise à jour. Réglages → À propos affiche la version et permet de vérifier à la main. Les réglages, voix et sons (`%APPDATA%\com.voxbox.app`) et le pack Voix IA sont conservés.

**Mettre à jour le pack Voix IA** : au lancement, VoxBox cherche une release « VoxBox - Voix IA N » plus récente que le pack installé (sa version est dans `resources\ai-pack.json`). Si le pack est installé, une pop-up la propose (une fois par version, puis une bannière) ; Réglages → Voix IA affiche la version du pack et permet de chercher ou d'installer à la main, et l'explorateur voice-models.com propose la mise à jour quand le pack est trop ancien pour l'ajout en ligne. VoxBox télécharge l'installeur, le vérifie contre `ai-pack-manifest.json` (taille et SHA-256), lui-même signé avec la clé des mises à jour de l'app (`scripts/ai_pack_manifest.mjs`, `crates/voxbox-aipack`), puis se ferme : l'installeur tourne en silence (autorisation Windows) et VoxBox redémarre. Les packs publiés avant ce manifeste (≤ 13) ne sont pas proposés.

Les versions antérieures à la mise à jour intégrée se mettent à jour une dernière fois à la main : quitter VoxBox (clic droit sur l'icône près de l'horloge → Quitter), puis lancer le `setup.exe` de la dernière release par-dessus.

Signature : la CI signe les installeurs de `main` avec le secret `TAURI_SIGNING_PRIVATE_KEY` et publie `latest.json` dans chaque release ; la clé publique est dans `src-tauri/tauri.conf.json`. L'app n'accepte qu'un installeur dont la signature porte sa version (`requireSignedVersion`), et la CI refuse de publier une signature sans version. Retirer une release : la supprimer entière, fichiers compris (une pre-release garde son installeur téléchargeable par les apps qui l'ont déjà proposée), jamais seulement son `latest.json`, et ne jamais relancer le run CI qui l'a construite (il la republierait) ; pour la remplacer, merger un correctif sur `main`, qui publie une version plus haute. `releases/latest` sert alors le `latest.json` de la release précédente et l'offre disparaît des apps, à condition que cette release en ait un (celles d'avant les mises à jour intégrées n'en ont pas : l'offre reste alors jusqu'à la release suivante). Un `latest.json` manquant ne se distingue pas d'une panne de GitHub : l'app garde l'offre en cours et signale que la recherche a échoué. Si la clé privée est perdue, en générer une nouvelle (`npx @tauri-apps/cli signer generate`), remplacer le secret et la clé publique : les apps déjà installées devront être réinstallées une fois à la main.

## Architecture

```
crates/voxbox-dsp         effets temps réel, 22 voix, catalogue des effets (Rust pur)
crates/voxbox-engine      moteur audio : WASAPI (cpal), anti-bruit, PTT, mixeur, sorties CABLE + casque
crates/voxbox-rvc         voix IA RVC v2 en streaming (ONNX Runtime chargé dynamiquement)
crates/voxbox-myinstants  recherche / téléchargement MyInstants (analyse HTML, pas d'API officielle)
crates/voxbox-voicemodels recherche voice-models.com, téléchargement et extraction des zips de modèles RVC
src-tauri                 app Tauri 2 : commandes, stockage JSON, raccourcis globaux (hooks bas niveau), tray
ui                        interface React (pixel art épuré : Voix, Sons, Réglages), mock intégré pour le navigateur
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

L'interface accepte des paramètres d'URL dans le navigateur : `?screen=voices|sounds|settings`, `?offline`, `?nocable`, `?update` (une version plus récente est publiée), `?update=fail` (son installation échoue).
Pour écouter une voix sans lancer l'app : `cargo run -p voxbox-dsp --example render -- villager in.wav out.wav`.

## Licences et attributions

- **VB-CABLE** est un donationware de VB-Audio (www.vb-cable.com), toutes les participations sont les bienvenues. Le pack officiel est redistribué tel quel et installé par son propre setup, comme le permet https://vb-audio.com/Services/licensing.htm. **En entreprise, quand les employés ne peuvent ni identifier VB-CABLE ni le financer, il faut acheter des licences VB-CABLE** ; un usage interne n'en dispense pas.
- **MyInstants** n'a pas d'API officielle : l'app lit les pages publiques du site, ce qui peut casser si le site change. L'analyse est isolée dans `crates/voxbox-myinstants/src/parser.rs` et testée sur des pages enregistrées. Les droits des sons restent ceux de leurs auteurs.
- **voice-models.com** n'a pas d'API officielle non plus : l'app lit la liste publique (`fetch_data.php`), analysée dans `crates/voxbox-voicemodels/src/parser.rs` et testée sur des réponses enregistrées. Les zips (huggingface.co le plus souvent) sont téléchargés en https, limités à 1 Go ; les liens Google Drive ne sont pas pris en charge. Seul le `.pth` est importé (chargé avec `weights_only=True` par PyTorch 2.10 ou plus récent, ses métadonnées bornées avant lecture, ses poids projetés en mémoire depuis le fichier, et le convertisseur limité à 4 Go de mémoire par le système) : l'`.index` d'une archive téléchargée n'est pas lu, car `faiss.read_index` n'est pas sûr sur un fichier de source inconnue. L'ajout en ligne exige un pack « VoxBox - Voix IA » récent (convertisseur avec `CONVERTER_API = 3`, qui borne l'architecture du modèle avant de le construire et borne ce qu'il charge en mémoire avant de l'avoir vérifié) ; avec un pack plus ancien, l'app propose de le mettre à jour en un clic. Les modèles appartiennent à leurs auteurs.
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
6. Débrancher le casque sans rien toucher : un message nomme le périphérique en cause. Le rebrancher : en quelques secondes « Son rétabli. » s'affiche tout seul, et Réglages montre de nouveau le casque et le micro choisis (si un autre micro est utilisé en attendant, Réglages le signale). En cas de souci, le journal est dans `%APPDATA%\com.voxbox.app\logs\voxbox.log`.
7. Pack Voix IA : voix « VCTK p231 », vérifier le backend affiché (DirectML) et la latence, puis importer un `.pth`, et ajouter un modèle depuis l'onglet voice-models.com (progression du téléchargement puis de la conversion).
